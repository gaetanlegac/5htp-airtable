/*----------------------------------
- DEPENDANCES
----------------------------------*/

// Npm
import ngrok from 'ngrok';

// Core
import { Anomaly } from '@common/errors';

// App
import type DataProvider from './provider';
import type { default as AirtableMaster, TTableMetadatas } from '.';
import typeHelpers from './typeHelpers';

/*----------------------------------
- TYPE
----------------------------------*/

const LogPrefix = '[airtable][webhooks]';

type TChangedFields = {
    [fieldId: string]: {
        current: TChangedfield,
        previous: TChangedfield,
    }
}

export type TChangedfield = {
    name?: string,
    type?: string
}

type TDestroyedFields = string[]

type TCreatedRecords = {
    [recordId: string]: {
        createdTime: string,
        cellValuesByFieldId: TValuesByFieldId
    }
}

type TChangedRecords = {
    [recordId: string]: {
        current: TValuesByFieldId,
        previous: TValuesByFieldId,
        unchanged: TValuesByFieldId,
    }
}

type TValuesByFieldId = {
    [fieldId: string]: any
}

type TDestroyedRecords = string[]


/*----------------------------------
- SERVICE
----------------------------------*/
export default class WebhooksConnector {

    private webhookId?: string;
    private webhookUrl?: string;

    public pendingCount: number = 0;
    private payloadCursor: number = 1;

    private errorsReportTimer: NodeJS.Timeout;

    public constructor( 
        public airtable: AirtableMaster,
        public app = airtable.app,
        public config = airtable.config
    ) {
        this.errorsReportTimer = setInterval(() => {

            airtable.createSyncReport(false);

        }, this.config.errorsReport.interval.new * 60 * 1000);
    }

    // TODO: on app cleanup, clearinterval

    /*----------------------------------
    - MAIN METHODS
    ----------------------------------*/

    public async register( fieldsIdToWatch: string[] ) {

        if (!this.config.enableRealTime)
            return;

        console.log(LogPrefix, `Registering webhook for watching ${fieldsIdToWatch.length} fields.`);
        if (this.webhookId !== undefined)
            throw new Error(`Webhooks already registered`);

        this.webhookUrl = await this.getEndpointUrl();

        // List existing Airtable webhooks
        const defaultSpace = this.airtable.config.spaces[ this.airtable.config.defaultSpace ];
        const existing = await this.get( defaultSpace );
        for (const wh of existing)
            if ((
                this.airtable.app.env.name === 'local'
                &&
                wh.notificationUrl?.includes('.ngrok.io')
            ) || (
                this.airtable.app.env.name === 'server'
                &&
                wh.notificationUrl?.startsWith( this.airtable.Router.http.publicUrl )
            ))
                await this.delete( defaultSpace, wh.id );

        // Desn't exists, create
        this.webhookId = await this.create(defaultSpace, fieldsIdToWatch);

        // Periodically check payload
        setInterval(() => {
            this.checkPayloads();
        }, 10000)
    }

    public async unregister() {

        if (!this.config.enableRealTime)
            return;

        if (this.airtable.app.env.name === 'local') {
            await ngrok.disconnect( this.webhookUrl )
        }
    }

    /*----------------------------------
    - INTERNAL METHODS
    ----------------------------------*/

    private async getEndpointUrl() {

        // Define the public url for receiving hooks
        let webhookHost: string;
        const webhookPath = '/system/webhook/airtable';
        if (this.airtable.app.env.name === 'local') {
            webhookHost = await ngrok.connect( this.airtable.Router.http.config.port );
        } else {
            webhookHost = this.airtable.Router.http.publicUrl;
        }

        return webhookHost + webhookPath;
    }

    private get( baseId: string ) {
        return this.airtable.query(
            'GET', 
            `/v0/bases/${baseId}/webhooks`
        ).then(response => response.webhooks)
    }

    private async create( baseId: string, fieldsIdToWatch: string[] ) {
        console.log(LogPrefix, 'Create webhook on base ' + baseId);

        const newWebhook = {
            notificationUrl: this.webhookUrl,
            specification: {
                options: {
                    filters: {
                        dataTypes: [
                            // Update data in real time from Airtable to the Databae
                            'tableData', 
                            // When field types are changed, we recheck their compatibility with the database ones
                            'tableFields'
                        ],
                        watchDataInFieldIds: fieldsIdToWatch,
                        changeTypes: ['add', 'update', 'remove'],
                        // Changes done by any way, except the public api
                        fromSources: [
                            'client',
                            'formSubmission',
                            'automation',
                            'system',
                            'sync'
                        ],
                    },
                    includes: {
                        // Test
                        includeCellValuesInFieldIds: 'all',
                        includePreviousCellValues: true,
                        includePreviousFieldDefinitions: true
                    }
                },
            }
        }

        const createResult = await this.airtable.query(
            'POST', 
            `/v0/bases/${baseId}/webhooks`,
            newWebhook
        )

        return createResult.id;
    }

    private delete( baseId: string, webhookId: string ) {
        console.log(LogPrefix, 'Delete webhook ' + webhookId + ' on base ' + baseId);
        return this.airtable.query(
            'DELETE', 
            `/v0/bases/${baseId}/webhooks/${webhookId}`
        )
    }

    public getPayloads( baseId: string, webhookId: string, cursor: number = 1 ) {
        return this.airtable.query(
            'GET', 
            `/v0/bases/${baseId}/webhooks/${webhookId}/payloads?limit=50&cursor=${cursor}`
        )
    }

    protected async checkPayloads() {

        // No webhok,were received recently
        if (this.pendingCount === 0)
            return;

        this.pendingCount = 0;

        if (this.webhookId === undefined)
            throw new Error(`this.webhookId not initiaized (did you call airtable.webhooks.register() ?)`);

        const defaultSpace = this.airtable.config.spaces[ this.airtable.config.defaultSpace ]

        let mightHaveMore: boolean;
        do {

            // Retrieve payloads
            const payloads = await this.getPayloads(
                defaultSpace,
                this.webhookId,
                this.payloadCursor
            );
    
            // Update status
            this.payloadCursor = payloads.cursor;
            mightHaveMore = payloads.mightHaveMore;

            // Process actions
            for (const payload of payloads.payloads) {
                await this.onPayload(payload);
            }

        } while (mightHaveMore === true);

        // run actions we have to do after every airtable sync
        await this.airtable.afterSync(false);
    }

    private async onPayload( payload ) {

        // Airtable may change the payloadFormat value in the future
        // TODO: Need to relaunch the initial sync ?
        if (payload.payloadFormat !== 'v0')
            throw new Anomaly(`Unsupported payload format: ${payload.payloadFormat}`, { payload });

        // https://airtable.com/developers/web/api/model/webhooks-table-changed
        for (const tableId in payload.changedTablesById) {

            const actions = payload.changedTablesById[ tableId ];

            // Get provider
            const provider = this.airtable.tableIdToProvider[ tableId ];
            if (provider === undefined)
                continue;

            if (actions.changedFieldsById)
                await this.onChangedFields( actions.changedFieldsById, provider );

            if (actions.destroyedFieldIds)
                await this.destroyedFieldIds( actions.destroyedFieldIds, provider );

            if (actions.createdRecordsById)
                await this.createdRecordsById( actions.createdRecordsById, provider );

            if (actions.changedRecordsById)
                await this.changedRecordsById( actions.changedRecordsById, provider );

            if (actions.destroyedRecordIds)
                await this.destroyedRecordIds( actions.destroyedRecordIds, provider );
        }
    }

    private async onChangedFields( changedFields: TChangedFields, provider: DataProvider ) {
        for (const fieldId in changedFields) {

            // Get field metadata
            const airtableCol = provider.airtable.tableMetas?.fieldsById[ fieldId ];
            if (airtableCol === undefined)
                continue;

            const databaseCol = provider.dbColViaAirtableFieldId[ fieldId ];
            if (databaseCol === undefined)
                continue; // Field not watched

            const { current, previous } = changedFields[fieldId];

            // Check compatibility of the new field type
            if (current.type !== undefined) {

                const updateMessage = `The type of the Airtable field "${airtableCol.name}" has been updated from "${previous.type}" to "${previous.type}"`
                console.warn(updateMessage);

                const typeHelper = typeHelpers[ current.type ];
                if (typeHelper === undefined)
                    provider.reportToSales(
                        'METAS',
                        airtableCol.name,
                        `:biohazard_sign: *CRITICAL ERROR*: ` + updateMessage + `.\n However, the ${previous.type} type isn't supported by the platform.`, 
                    );

                const compatibilityError = typeHelper.hasCompatibilityError(airtableCol, databaseCol);
                if (compatibilityError !== false)
                    provider.reportToSales(
                        'METAS',
                        airtableCol.name,
                        `:biohazard_sign: *CRITICAL ERROR*: ` + updateMessage + `.\n However, the ${previous.type} type isn't compatible with the platform database (${databaseCol.type.js.raw}).`, 
                    );
            }

            // Fields are identified by name
            if (current.name !== undefined) {
                provider.reportToSales(
                    'METAS',
                    airtableCol.name,
                    `:biohazard_sign: *CRITICAL ERROR*: The airtable field "${airtableCol.name}" has been renammed to "${current.name}."
                    By changing the name of a field, the platform is unable to sync from Airtable anymore.`, 
                );
            }
        }
    }

    private async destroyedFieldIds( destroyedFields: TDestroyedFields, provider: DataProvider ) {
        for (const fieldId of destroyedFields) {

            // Get field metadata
            const airtableCol = provider.airtable.tableMetas?.fieldsById[ fieldId ];
            if (airtableCol === undefined)
                continue;

            const databaseCol = provider.dbColViaAirtableFieldId[ fieldId ];
            if (databaseCol === undefined)
                continue; // Field not watched

            provider.reportToSales(
                'METAS',
                airtableCol.name,
                `:biohazard_sign: *CRITICAL ERROR*: An important column has been deleted from Airtable: ${airtableCol.name} (attached to db column ${databaseCol.pathname}).\n
                It means that some data were loss and the platform is unable to sync from Airtable.`, 
            );
        }
    }

    private async createdRecordsById( 
        createdRecords: TCreatedRecords, 
        provider: DataProvider 
    ) {
        const airtableTable = provider.airtable.metadatas();

        const airtableRecordsV1 = Object.entries(createdRecords).map(([ recordId, values ]) => {

            // Associate field name to value
            const cellValues = this.cellValuesV2toV1(values.cellValuesByFieldId, airtableTable);

            return {
                recordId,
                ...cellValues
            }
        });

        // Convert airtable records to database records
        const { recordsForDb, relations, table: dbTable } = provider.airtableToDb(airtableRecordsV1);
        console.log("createdRecordsById: databaseRecords", recordsForDb, dbTable.chemin);

        // Insert new records
        const insertResult = await this.airtable.SQL.insert( provider.tableName, recordsForDb );
        console.log("createdRecordsById: insertResult", insertResult);
        provider.syncStats.inserted += insertResult.affectedRows;

        // Update ids index in memory
        for (const recordId in createdRecords) {
            const createdRecord = createdRecords[ recordId ];

            // TODO: use provider.database.pk
            if (dbTable.pk.length !== 1)
                throw new Anomaly(`The number of pks must be strictly equal to zero, otherwise, unable to determine which pk to use for relation records.`);
            const dbPk = dbTable.pk[0];
            const dbPkMapper = provider.mapper[ dbPk ];
            if (dbPkMapper === undefined)
                continue;

            // Update the ids index
            const dbPkValue = createdRecord[ dbPkMapper.airable ];
            console.log(`Update the ids indexes with the newsly created record id from ${provider.itemName}: ${recordId} (airtable) > ${dbPkValue} (database)`);
            provider.airtableToDbId[ recordId ] = dbPkValue;
            provider.dbIdToAirtableId[ dbPkValue ] = recordId;
        }

        // Update relationships
        await provider.updateRelations(relations);
    
    }

    /**
     * When a record has been changed from Airtable.
     * NOTE:    It's possible that a record has been rejected when it has been created because it was incomplete 
     *          (for ex: because one of our collaborator was creating this record manually so all required fields were not filled)
     *          That's why when a record is changed, we use upsert so we ensure the record is created if not the case
     * NOTE2:   No need to update the ids index since ids can't be updated n airtable (https://community.airtable.com/t5/other-questions/record-id-changed/td-p/113803)
     * @param changedRecords 
     * @param provider 
     */
    private async changedRecordsById( changedRecords: TChangedRecords, provider: DataProvider ) {

        const table = provider.airtable.metadatas();

        const airtableRecordsV1 = Object.entries( changedRecords ).map(([ recordId, record ]) => {

            // Values were changed, errors, re not valable anymore
            const fieldNamesCurrent: string[] = []
            for (const fieldId in record.current.cellValuesByFieldId) {
                const fieldMetas = this.fieldMetasFromId(table, fieldId)
                if (fieldMetas !== null) // The field has been recognised
                    fieldNamesCurrent.push( fieldMetas.name );
            }
            provider.fixError({ recordId }, fieldNamesCurrent);

            // Associate field name to value
            const changedValues = this.cellValuesV2toV1(record.current.cellValuesByFieldId, table);
            // Used in case of the record hasn't been created before
            const unchangedValues = this.cellValuesV2toV1(record.unchanged.cellValuesByFieldId, table);

            return {
                recordId,
                ...unchangedValues,
                ...changedValues,
            }
        })

        // Convert airtable records to database records
        const { recordsForDb, relations } = provider.airtableToDb(airtableRecordsV1);

        // Create update queries
        const updateRecords = await this.airtable.SQL.upsert( provider.tableName, recordsForDb, {
            '*': true,
            updated: new Date
        });
        provider.syncStats.upserted += updateRecords.affectedRows;

        // Update relationships
        await provider.updateRelations(relations);
    }

    private fieldMetasFromId( table: TTableMetadatas, fieldId: string ) {

        const fieldMetas = table.fieldsById[ fieldId ];
        if (fieldMetas === undefined)
            return null;
            /*throw new Anomaly(`Unable to get fields metas via fieldID "${fieldId}" in Airtable table "${table.name}"`, {
                knownFields: table.fieldsById
            });*/

        return fieldMetas;

    }

    private cellValuesV2toV1( fieldValues: any, table: TTableMetadatas ) {
        const valuesv1: {[fieldBame: string]: any} = {};
        for (const fieldId in fieldValues) {

            const fieldMetas = this.fieldMetasFromId(table, fieldId);
            if (fieldMetas === null) // Unknown field = ignore
                continue;

            const typeHelper = typeHelpers[ fieldMetas.type ];
            if (typeHelper === undefined)
                throw new Anomaly(
                    `The Airtable field ${fieldMetas.pathName} has an unsupported type: ${fieldMetas.type}`, {
                    fieldMetas
                });
                
            // Transform to cell value
            let fieldValue = fieldValues[fieldId];
            if (typeHelper.toV1)
                fieldValue = typeHelper.toV1(fieldValue)

            // Index value by fieldname
            const fieldName = fieldMetas.name;
            valuesv1[ fieldName ] = fieldValue;
        }
        return valuesv1;
    }

    private async destroyedRecordIds( destroyedRecords: TDestroyedRecords, provider: DataProvider ) {

        for (const recordId of destroyedRecords) {

            // Fixed errors: Values were changed, errors are not valable anymore
            provider.fixError({ recordId });

            // Delete from memory
            const dbId = provider.airtableToDbId[ recordId ];
            delete provider.airtableToDbId[ recordId ];
            delete provider.dbIdToAirtableId[ dbId ];
        }

        // Delete records from db
        console.log(LogPrefix, `destroyedRecordIds`, destroyedRecords);
        const deleteResult = await this.airtable.SQL.delete(
            provider.tableName, 
            this.airtable.SQL`airtableId IN (${destroyedRecords})`
        )
        provider.syncStats.deleted += deleteResult.affectedRows;
    }
}