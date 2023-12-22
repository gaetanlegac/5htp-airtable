/*----------------------------------
- DEPENDANCES
----------------------------------*/

// Npm
import ShortUniqueId from 'short-unique-id';

// Core
import type { Application } from '@server/app';
import Service from '@server/app/service';
import { Anomaly } from '@common/errors';
import { arrayToObj } from '@common/data/tableaux';

// Specific 
import AirtableTable, { TMethod, TQueryDataObj } from './table';
import type { default as DataProvider, TSyncStats, TProviderAction } from './provider';
import WebhooksConnector from './webhooks';
import { TFieldType, TTypeHelper } from './typeHelpers';

// Export
export { default as Provider } from './provider';
export { default as ProviderInterface } from './provider/interface';
export { default as RemoteProvider } from './provider/remote';

/*----------------------------------
- CONST
----------------------------------*/

const LogPrefix = '[airtable]';

const uid = new ShortUniqueId({ length: 10 });

/*----------------------------------
- TYPES
----------------------------------*/

export { default as AirtableTable } from './table';

export type TBaseName<Config extends TConfig> = keyof Config["spaces"];

export type TConfig<TApp extends Application = Application> = {

    enable: boolean,
    enableSync: boolean,
    enableUpdate: boolean,
    enableRealTime: boolean,
    debug: boolean,
    apiKey: string,
    defaultSpace: string,
    // Map each table name to airtable ID
    spaces: {[name: string]: string},

    errorsReport: {
        interval: {
            new: number, 
            reminder: number
        }
    },

    afterSync: (
        report: TSyncReportObject,
        stats: TSyncStats,
        isInitial: boolean,
        app: TApp,
        airtable: AirtableMasterService
    ) => Promise<void>
}

export type THooks = {

}

export type Services = {
    
}

type TLatestSyncTimes = {[providerId: string]: string}

export type TQueryOptions = {
    urlSuffix?: string
}

/*----------------------------------
- TYPES: AFTER SYNC REPORT
----------------------------------*/

type TSyncReportObject = {
    simplified: string[],
    technical: string
}

/*----------------------------------
- TYPES: RAW METADATAS
----------------------------------*/

export type TRawBaseMetadatas = {
    tables: TRawTableMetadatas[]
}

export type TRawTableMetadatas = {
    id: string,
    name: string,
    primaryFieldId: string,
    fields: TRawFieldMetadata[],
    views: TViewMetadata[]
}

export type TRawFieldMetadata = {
    id: string,
    name: string,
    type: TFieldType,
    options: any // TODO: To type
}

type TViewMetadata = {

}

export type AirtableAttachement = {
    id: string,
    url: string,
    thumbnails: {
        small: {
            url: string,
            width: string,
            height: string,
        },
        large: {
            url: string,
            width: string,
            height: string,
        },
    },
    filename: string,
    size: number,
    type: string
}

/*----------------------------------
- TYPES: METADATAS
----------------------------------*/
export type TTableMetadatas = With<TRawTableMetadatas, {
    fields: TFieldsMetadata,
    fieldsById: TFieldsMetadata,
}>

export type TTablesMetadata = {
    [tableNameOrId: string]: TTableMetadatas
}

export type TFieldsMetadata = {
    [fieldName: string]: TFieldMetadata
}
export type TFieldMetadata = TRawFieldMetadata & {
    pathName: string
}

/*----------------------------------
- SERVICE
----------------------------------*/
export default class AirtableMasterService<Config extends TConfig = TConfig> 
    extends Service<TConfig, THooks, Application, Services> {

    public SQL = this.use('Core/Database/SQL');
    public Router = this.use('Core/Router');
    public Fetch = this.use('Core/Fetch'); // Send request to remote providers

    // Services
    public webhooks = new WebhooksConnector(this);

    // Indexes
    public providers: {[providerId: string]: DataProvider} = {}
    public tableIdToProvider: {[tableId: string]: DataProvider} = {}
    private fieldsIdToWatch: string[] = []
    public latestSyncTimes: TLatestSyncTimes = {}

    /*----------------------------------
    - LIFECYCLE
    ----------------------------------*/

    protected async start() {

        if (this.config.enable === false)
            return;

        // Load matadatas to enable structural checkings
        const { defaultSpace } = this.config;
        this.tableMetasByName = await this.loadMetadatas( this.config.spaces[ defaultSpace ] );

        // Load the latest sync times for providers
        //if (this.app.env.profile === 'dev') {

            // Dev version = reduce yime to reload
            const syncTimesList = await this.SQL`SELECT provider, syncTime FROM airtableLatestSync`.all();
            this.latestSyncTimes = arrayToObj( syncTimesList, { index: 'provider', val: 'syncTime' });
        //}
    }

    public async ready() {

        // Register Airtable Hooks for receiving and syncing changes from Airtable to the database
        await this.webhooks.register( this.fieldsIdToWatch );

        // Run actions we have to do after every airtable sync
        await this.afterSync(true);

        // Create a sync report 
        await this.createSyncReport(true);
    }
  
    public async shutdown() {

        await this.webhooks.unregister();
    }

    /*----------------------------------
    - ACTIONS
    ----------------------------------*/

    private async loadMetadatas( baseId: string ) {

        // https://airtable.com/api/meta
        const metas = await this.query('GET', `/v0/meta/bases/${baseId}/tables`) as TRawBaseMetadatas;

        // Load metadaas
        const tableMetasByName: TTablesMetadata = {}
        const tablesByID: TTablesMetadata = {}
        for (const tableMetas of metas.tables) {

            // Index table fields
            const fieldsByName: TFieldsMetadata = {}
            const fieldsById: TFieldsMetadata = {}
            for (const fieldMetas of tableMetas.fields) {

                const airtableColPath = tableMetas.name + '.' + fieldMetas.name;

                const field: TFieldMetadata = {
                    ...fieldMetas,
                    pathName: airtableColPath
                }

                fieldsByName[ field.name ] = field
                fieldsById[ field.id ] = field
            }
            
            // Index table
            const table: TTableMetadatas = {
                ...tableMetas,
                fields: fieldsByName,
                fieldsById
            }

            tableMetasByName[ tableMetas.name ] = tablesByID[ tableMetas.id ] = table;
        }

        // Load metas and bind them to every provider
        for (const providerId in this.providers) {

            // Retrieve table information for this provider
            const provider = this.providers[ providerId ];
            const tableMetas = tableMetasByName[ provider.airtable.table ];
            if (tableMetas === undefined)
                throw new Anomaly(`Couldn't get table airtable metas for ${provider.airtable.tablePath}.`, {
                    loadedMetas: tableMetasByName
                });

            // Check required table 
            this.checkRequiredField(tableMetas, 'Created', 'createdTime');
            this.checkRequiredField(tableMetas, 'Updated', 'lastModifiedTime');

            // Associate table ID to provider
            this.tableIdToProvider[ tableMetas.id ] = provider;

            // Load metadatas
            const providerMetas = provider.loadMetadatas(tableMetas);
            // Add field IDs to watch in webhooks
            this.fieldsIdToWatch.push(...providerMetas.fieldsId);
        }

        return tableMetasByName;
    }

    private checkRequiredField( 
        table: TTableMetadatas,
        fieldName: string, 
        fieldType: TFieldType 
    ) {

        if (table.fields[ fieldName ] === undefined) 
            throw new Error(`All synced Airtable table should have a Updated field.
                This is not the case for the table "${table.name}".`);

        const actualFieldType = table.fields[ fieldName ].type;
        if (actualFieldType !== fieldType) 
            throw new Error(`The "Updated" in the "${table.name}" Airtable table should be typped as "${fieldType}" (actual type: "${actualFieldType}")`);
    }

	/*----------------------------------
    - PROVIDERS MANAGEMENT
    ----------------------------------*/

    /**
     * Register a Airtable provider instance to the Airtable Service
     * And bind the table metas to it
     * WARN: It should be called in the constructor of the class where is declared the airtable property
     * @param provider 
     * @returns 
     */
    public registerProvider( provider: DataProvider ) {
        
        // Register to the airtable service so it can periofically sync after the initial sync
        this.providers[ provider.itemName ] = provider;
    }

    /*----------------------------------
    - QUERY
    ----------------------------------*/
    public table( baseName: TBaseName<Config>, tableName: string ) { 
        return new AirtableTable<Config>(this, baseName, tableName);
    }

    public genId() {
        return uid();
    }

    public query( method: TMethod, url: string, data?: TQueryDataObj, options: TQueryOptions = {}) {

        url = 'https://api.airtable.com' + url;

        // Query parameters
        let urlParamsString: string = ''
        if (method === 'GET' && data !== undefined) {
            const urlParams = new URLSearchParams(data)
            urlParamsString += urlParams.toString();
            data = undefined;
        }

        // Allows us to add url parameters without using URLSearchParams
        // Because it encodes characters we don't to encode (for ex the filterByFormula option)
        if (options.urlSuffix !== undefined)
            urlParamsString += (urlParamsString === '' ? '' : '&') + options.urlSuffix;

        // Append url parameters
        if (urlParamsString !== '')
            url += '?' + urlParamsString;

        //Run request
        this.log(`${method} ${url}`/*, data*/);
        return fetch( url, {
            method: method,
            headers: {
                Authorization: 'Bearer ' + this.config.apiKey,
                "Content-Type": 'application/json'
            },
            body: data ? JSON.stringify(data) : null
        }).then( res => res.json() ).then( res => {

            if ('error' in res) {
                console.error(LogPrefix, `Got error from airtable:`, res);
                throw new Anomaly(LogPrefix + ` Failed to ${method} airtable records: ${res.error.type}`, {
                    url,
                    method: method,
                    headers: {
                        Authorization: 'Bearer ' + this.config.apiKey,
                        "Content-Type": 'application/json'
                    },
                    body: data ? JSON.stringify(data) : null,
                    res
                });
            }

            return res;
        })
    }

    public async handleRemoteRequest( 
        providerId: string, 
        action: TProviderAction,
        data: object 
    ) {

        // Get provider via ID
        const provider = this.providers[ providerId ];
        if (provider === undefined)
            throw new Error(`No provider "${providerId}" has been found.`);

        // Check if provider.options.remote
        if (provider.options.remote !== true)
            throw new Error(`Remote access has not been enabled for provider "${providerId}".`);

        // Switch action
        switch (action) {
            case 'create':
                return await provider.create( data.record, data.airtableRecord );
            case 'update':
                return await provider.update( data.records, data.simulate );
            case 'delete':
                return await provider.delete( data.recordIds );
            default:
                throw new Error('Unknown action: "' + action + '"')
        }
    }

    /*----------------------------------
    - REPORTING
    ----------------------------------*/
    private log(...args: any[]) {
        return this.config.debug && console.log( LogPrefix + `[${this.baseName}]`, ...args);
    }

    private hasEmptyStats( stats: TSyncStats ) {
        return (
            stats.deleted + 
            /*stats.upserted + 
            stats.inserted +*/
            stats.excluded + 
            stats.errors
        ) === 0
    }

    public async afterSync( isInitial: boolean ) {
        
        const syncTimesList = Object.entries( this.latestSyncTimes ).map(([ provider, syncTime ]) => ({
            provider, syncTime
        }))

        await this.SQL.upsert('airtableLatestSync', syncTimesList, ['syncTime']);
    }

    public async createSyncReport( initial: boolean ) {

        const neededIterationsForReminder = this.config.errorsReport.interval.reminder / this.config.errorsReport.interval.new;

        const report: TSyncReportObject = {
            simplified: [],
            technical: ''
        }

        const totalStats: TSyncStats = {
    
            fromAirtable: 0,
            errors: 0,

            inserted: 0,
            updated: 0,
            upserted: 0,
            excluded: 0,
            deleted: 0,

            upsertedRelations: 0,
            deletedRelations: 0,
        }

        for (const providerId in this.providers) {

            const provider = this.providers[providerId];
            const { errors, stats, deleted, errorsForSales } = provider.getSyncResults();

            // errors for sales (missing data, ...)
            const errorsListforSales: string[] = []
            for (const rowId in errorsForSales) {
                const errorsListRow: string[] = []
                const rowError = errorsForSales[ rowId ];
                for (const fieldName in rowError.fields) {

                    const fieldError = rowError.fields[ fieldName ];
                    if (fieldError === null) continue; // error has been deleted

                    // New error, or reminder
                    if (fieldError.iterations === 0) {
                        errorsListRow.push(fieldError.error);
                    } else if (fieldError.iterations >= neededIterationsForReminder) {
                        errorsListRow.push('(Reminder) ' + fieldError.error);
                        fieldError.iterations = 0;
                    }

                    fieldError.iterations++;
                }

                if (errorsListRow.length !== 0) {

                    const recordName: string[] = []
                    for (const val of Object.values( rowError.record ))
                        if (val && (typeof val === 'string' && val.length < 100) || typeof val === 'number')
                            recordName.push(val);

                    const tableName = provider.airtable.table + ':' 
                        + (recordName.length === 0 ? 'Empty record' : recordName.slice(0, 3).join(' / ')
                            .replace(/\&/g, '&amp;').replace(/\</g, '&lt;').replace(/\>/g, '&gt;'))

                    const link = provider.getRecordUrl(rowId);

                    errorsListforSales.push(
                        `<${link}|${tableName}>`,
                        '```' + errorsListRow.join('\n') + '```'
                    );
                }
            }
            if (errorsListforSales.length !== 0)
                report.simplified.push( errorsListforSales.join('\n') );

            // Check if something to report for this provider
            if (!this.hasEmptyStats( stats )) {

                // TODO: Send deleted as attachment

                // Increment stats
                totalStats.errors += stats.errors;
                totalStats.inserted += stats.inserted;
                totalStats.updated += stats.updated;
                totalStats.upserted += stats.upserted;
                totalStats.deleted += stats.deleted;
                totalStats.excluded += stats.excluded;
                totalStats.upsertedRelations += stats.upsertedRelations;
                totalStats.deletedRelations += stats.deletedRelations;

                // Provider header
                report.technical += `
*${providerId}*
From: ${provider.airtable.tablePath} | Records: ${stats.fromAirtable} | To: ${provider.tableName}
Inserted: ${stats.inserted} | Updated: ${stats.updated} | Upserted: ${stats.upserted}
Excluded: ${stats.excluded} | Deleted: ${stats.deleted}
Upserted Relations: ${stats.upsertedRelations} | Deleted Relations: ${stats.deletedRelations}
`

                // Print errors
                for (const rowId in errors) {
                    const { record, fields } = errors[rowId];
                    totalStats.errors += Object.keys(fields).length;
                    report.technical += `
${Object.entries(fields).map(([ fieldName, field ]) => 
    fieldName + ' : ' + rowId + ': ' + field.error + 
    (field.data !== undefined ? '\n```' + JSON.stringify(field.data) + '```' : '')
).join('\n')}
                    `
                }
            }
        }

        await this.config.afterSync( report, totalStats, initial, this.app, this );
            
    }
}