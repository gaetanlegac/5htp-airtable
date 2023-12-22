/*----------------------------------
- DEPENDANCES
----------------------------------*/

// Npm
import dayjs from 'dayjs';
import dayjs_utc from 'dayjs/plugin/utc';
import dayjs_tz from 'dayjs/plugin/timezone';
dayjs.extend(dayjs_utc)
dayjs.extend(dayjs_tz)

// Core
import type { Application } from '@server/app';
import type { TMetasTable, TMetasColonne as DatabaseColumn } from '@server/services/database/metas';
import { Anomaly } from '@common/errors';
import markdown from '@common/data/markdown';

// App
import type { 
    AirtableTable, 
    TTableMetadatas as AirtableTableMetas,
} from '..';
import ProviderInterface, { TAirtableModel, SyncableDatabaseRecord, With } from './interface';

// Specific
import typeHelpers from '../typeHelpers';

/*----------------------------------
- CONFIG
----------------------------------*/

const LogPrefix = '[airtable][provider]';

export const renderMd = (text: string) => text === undefined 
    ? undefined 
    : (text.trim().toLowerCase() === 'n/a'
        ? undefined
        : markdown.render(text)
)

/*----------------------------------
- TYPES
----------------------------------*/

export type { AirtableAttachement } from '..';

type TProviderOptions = {
    remote?: boolean
}

type TRelationsIndex = {
    [relationTableName: string]: {
        pk: string,
        fk: string,
        values: {
            [key: string]: any
        }[]
    }
}

type TUpdatedData<DatabaseModel extends SyncableDatabaseRecord = SyncableDatabaseRecord> = {
    records: DatabaseModel[] ,
    relations: TRelationsIndex
}

type TSyncErrorsForDevs = {
    [rowId: string]: {
        record: { recordId: string },
        fields: {
            [airtableFieldName: string]: {
                error: string,
                data?: {}
            }
        }
    }
}

type TSyncErrorsForSales = {
    [rowId: string]: {
        record: 'METAS' | { recordId: string },
        fields: {
            [airtableFieldName: string]: null | {
                error: string,
                iterations: number
            }
        }
    }
}

export type TSyncStats = {
    
    fromAirtable: number,

    inserted: number,
    updated: number,
    excluded: number,
    upserted: number,
    deleted: number,

    upsertedRelations: number,
    deletedRelations: number,

    errors: number
}

/*----------------------------------
- TYPES: MAPPER
----------------------------------*/
export type TAirtableMapper<
    AirtableModel extends TAirtableModel = TAirtableModel,
    DatabaseModel extends SyncableDatabaseRecord = SyncableDatabaseRecord,
    Relations extends {} = {},
    TAirtableKey extends keyof AirtableModel = keyof AirtableModel
> = {
    // NOTE: all needed airtable fields should be referenced here
    //  Because we need to determine whihc fields we have to watch in the webhook callback
    [databaseColName in keyof (Omit<DatabaseModel, 'airtableId'|'created'|'updated'|'synced'> & Relations)]: (
        // Calculated from airtable values
        TFuncValueMapper<AirtableModel>
        | 
        // Mirror airtable values
        (
            // Airtable field to mirror
            {
                airtable: TAirtableKey,
                // We only filter the value if it's not undefined, so exclude undefined
                filter?: (value: Exclude<AirtableModel[TAirtableKey], undefined>) => 
                    (DatabaseModel & Relations)[databaseColName]
            } 
            & 
            ({
                extra?: true
            } | {
                // Will convert airtable ids in database ids
                //toOne: (idOnAirtable: AirtableModel[ TAirtableKey ]) => string | null,
                toOne: () => DataProvider
            } | {
                // Will create relation record in database
                toMany: () => ToManyRecord,
            })
        )
    )
}

type TFuncValueMapper<
    AirtableModel extends TAirtableModel = TAirtableModel, 
    TAirtableKey extends keyof AirtableModel = keyof AirtableModel
> = {
    airtable: TAirtableKey[],
    func: (record: Pick<AirtableModel, TAirtableKey>) => any,
    extra?: true
} 

// TODO: TRelationModel = Models[ tableName ]
type ToManyRecord<
    TRelationModelName extends keyof ModelsTypes = keyof ModelsTypes, 
    TRelationModel = ModelsTypes[TRelationModelName]
> = {
    table: TRelationModelName,
    pk: {
        key: keyof TRelationModel,
    },
    fk: {
        provider: DataProvider,
        key: keyof TRelationModel,
    }
}

/*----------------------------------
- SERVICZ
----------------------------------*/
export default abstract class DataProvider<
    AirtableModel extends TAirtableModel = TAirtableModel,
    DatabaseModel extends SyncableDatabaseRecord = SyncableDatabaseRecord,
    Relations extends {} = {},
    AirtableModelWithId extends AirtableModel & { recordId: string } = AirtableModel & { recordId: string },
> implements ProviderInterface {

    /*----------------------------------
    - CONFIG
    ----------------------------------*/

    // Input
    public abstract airtable: AirtableTable;

    // Transform: db keys => airtable keys
    // When undefined, provider not linkedin to database
    public abstract mapper?: TAirtableMapper<AirtableModel, DatabaseModel, Relations>;
    public abstract tableName?: string; // When undefined, provider not linkedin to database

    // Metas
    public dbMetas!: TMetasTable;
    public dbColViaAirtableFieldId: {[fieldId: string]: DatabaseColumn} = {};

    // Status
    private syncErrors: TSyncErrorsForDevs = {}
    private errorsForSales: TSyncErrorsForSales = {}
    private deletedList: DatabaseModel[] = []
    public syncStats: TSyncStats = {

        fromAirtable: 0,

        inserted: 0,
        updated: 0,
        excluded: 0,
        upserted: 0,
        deleted: 0,

        upsertedRelations: 0,
        deletedRelations: 0,

        errors: 0
    }

    public constructor(
        public app: Application,
        public itemName: string,
        public options: TProviderOptions = {}
    ) {
        
    }

    /*----------------------------------
    - INDEXED DATA
    ----------------------------------*/
    // WARN: Should ALWAYS BE UPDATED AT THE SAME TIME
    // RecordId (airtable) => slug (database)
    public airtableToDbId: {[recordId: string]: string} = {};
    // Slug (database) => RecordId (airtable) 
    public dbIdToAirtableId: {[recordId: string]: string} = {};

    public getDbId( airtableId: string, throwError: boolean = false ): string | null {

        const databaseId = this.airtableToDbId[ airtableId ];
        if (databaseId === undefined) {
            if (throwError)
                throw new Anomaly(`Couldnt get the database id for airtableId "${airtableId}" in provider ${this.itemName}`, {
                    airtableId,
                    indexed: Object.keys(this.airtableToDbId),
                    isIn_airtableToDbId: (airtableId in this.airtableToDbId)
                });
            else
                return null;
        }

        return databaseId;
    }

    public getAirtableId( dbId: string, throwError: boolean = false ): string | null {

        const databaseId = this.dbIdToAirtableId[ dbId ];
        if (databaseId === undefined) {
            if (throwError)
                throw new Anomaly(`Couldnt get the airtableID for foreign key "${dbId}" in provider ${this.itemName}`, {
                    dbId,
                    indexed: Object.keys(this.dbIdToAirtableId),
                    isIn_idToAirtableId: (dbId in this.dbIdToAirtableId)
                });
            else
                return null;
        }

        return databaseId;
    }
    
    /*----------------------------------
    - LOAD FROM AIRTABLE
    ----------------------------------*/

    public abstract sync(): Promise<void>;

    private dbTable() {

        if (this.dbMetas === undefined)
            throw new Anomaly(`
                dbTable() has been called, but the tablemetas werenot loaded before. 
                Did you forget to put Airtable.registerProvider(this); in the provider constructor?
            `, 
                Object.keys(this.airtable.master.providers)
            );

        if (this.dbMetas.pk.length !== 1)
            throw new Anomaly(`The number of pks must be strictly equal to zero, otherwise, unable to determine which pk to use for relation records.`);
        const dbPk = this.dbMetas.pk[0];

        return {
            databaseTable: this.dbMetas,
            dbPk
        };
    }

    /**
     * Check that all the fields the mapper makes references to are well existing and have a compatible format
     */
    public loadMetadatas( tableMetas: AirtableTableMetas ) {
        
        // Index metas
        this.airtable.tableMetas = tableMetas;

        // Extract metas
        this.dbg('log', LogPrefix, `Check structure between airtable table ${this.airtable.table} and database table ${this.tableName}`);
        const airtableTable = this.airtable.metadatas();
        const databaseTable = this.airtable.master.SQL.database.getTable( this.tableName );
        this.dbMetas = databaseTable;

        // Chec every field of the mapper
        const fieldsId = new Set<string>();
        for (const databaseColName in this.mapper) {
            const mappedCol = this.mapper[ databaseColName ];

            // Normalize to array
            const isColumnMirrored = typeof mappedCol.airtable === 'string';
            const airtableColsName = isColumnMirrored
                ? [mappedCol.airtable]
                : mappedCol.airtable;

            // Don't check for db column if...
            const checkDatabaseColumn = !(
                // It's a toMany relation
                ('toMany' in mappedCol) 
                ||
                // It's a extra data (will not be pesisted into database)
                mappedCol.extra === true
            );

            // Get database column metas
            let databaseCol: DatabaseColumn | undefined;
            if (checkDatabaseColumn) {

                databaseCol = databaseTable.colonnes[ databaseColName ];
                if (databaseCol === undefined)
                    throw new Error(`Airtable sync mapper: Database column ${databaseTable.chemin + '.' + databaseColName} doesn't exists.
                        Known fields for ${databaseTable.chemin}: ` + Object.keys( databaseTable.colonnes ));

                // Associate the field id to the corresponding db column metas
                if (isColumnMirrored) {
                    const [airtableColName] = airtableColsName;
                    const fieldId = tableMetas.fields[ airtableColName ]?.id;
                    if (fieldId !== undefined)
                        this.dbColViaAirtableFieldId[ fieldId ] = databaseCol
                }
            }
            
            // Check every mapped airtable field
            for (const airtableColName of airtableColsName) {

                // Get airtable col metas
                const airtableCol = airtableTable.fields[ airtableColName ];
                const airtableColPath = this.airtable.tablePath + '.' + airtableColName;
                if (airtableCol === undefined)
                    throw new Error(`Airtable sync mapper: Airtable column ${airtableColPath} doesn't exists. 
                        Known fields for ${this.airtable.tablePath}: ` + Object.keys( airtableTable.fields ));

                const typeHelper = typeHelpers[ airtableCol.type ];
                if (typeHelper === undefined)
                    throw new Anomaly(
                        `The Airtable field ${airtableCol.pathName} has an unsupported type: ${airtableCol.type}`, {
                        airtableCol
                    });

                // relationship = should be a multipleRecordLinks
                if ((('toOne' in mappedCol) || ('toMany' in mappedCol)) && airtableCol.type !== 'multipleRecordLinks')
                    throw new Anomaly(
                        `The Airtable field ${airtableCol.pathName} as mapped to another record, but it's not a multipleRecordLinks on the Airtable side.`, {
                        airtableCol
                    });

                fieldsId.add(airtableCol.id);

                /*
                    NOTE: We don't test if the airtable field has been configurated for single of multiple fields
                        Because when we link to another record a synced field (ex: bizdev.Geolocations*.parent),
                        field.options.prefersSingleRecordLink isn't provided
                */                  

                // Lookup = get real type
                if (airtableCol.type === 'multipleLookupValues') {
                    const realType = airtableCol.options?.result;
                    if (realType === undefined)
                        throw new Anomaly(`Airtable async mapper: couldn't get the real value of multipleLookupValues`, {
                            airtableCol
                        });

                    airtableCol.type = realType.type;
                    airtableCol.options = realType.options;
                }

                // Both have a compatible type
                if (databaseCol !== undefined) {
                    const compatibilityError = typeHelper.hasCompatibilityError(airtableCol, databaseCol);
                    if (compatibilityError !== false)
                        throw new Error(`The Airtable col ${airtableCol.pathName} (type: ${airtableCol.type}) isn't compatible with the database col ${databaseCol.pathname} (type: ${databaseCol.type.js.name}): ` + compatibilityError);
                }
            }
        }

        return { fieldsId, databaseTable }
    }

    protected async viaAirtable(): Promise<null | TUpdatedData<DatabaseModel>> {

        // Disable providers sync
        if (!this.airtable.master.config.enable || !this.airtable.master.config.enableSync)
            return null;

        // Sync via the REST API
        const {
            recordsForDb,
            relations
        } = await this.runInitialSync();

        // Count the number of entries we got via airtable
        this.syncStats.fromAirtable = Object.keys( this.airtableToDbId ).length
        this.dbg('log',  LogPrefix, this.syncStats.fromAirtable, this.itemName, ' from airtable');

        // Return the data we need to insert into the db
        return recordsForDb.length === 0
            ? null
            : { records: recordsForDb, relations }
    }

    private async runInitialSync() {

        console.info( LogPrefix, `Syncing`, this.airtable.table, 'with', this.dbMetas.nom);

        const { databaseTable, dbPk } = this.dbTable();

        // Index the already known ids from database
        const fromDb = await this.airtable.master.SQL<DatabaseModel & { airtableId: string }>`
            SELECT airtableId, :${dbPk}
            FROM :${this.tableName}
            WHERE airtableId IS NOT NULL
        `.all();

        // Create airtableToDbId
        for (const record of fromDb) {
            const dbPkValue = record[ dbPk ];
            const indexVal = record.airtableId;
            this.airtableToDbId[ indexVal ] = dbPkValue;
            this.dbIdToAirtableId[ dbPkValue ] = indexVal;
        }
        this.dbg('log', `Indexed ${fromDb.length} entries by airtableId (dbPk: ${dbPk}) from database data.`);

        if (this.airtable.master.config.enable === false)
            return { recordsForDb: [], relations: {} };

        // Retireve latest sync time
        const latestSyncTime = this.airtable.master.latestSyncTimes[ this.itemName ]

        // Load current records list from airable
        // TODO: whee updated OR created date > latest sync time
        this.dbg('log', 'Sync from airtable to database');
        const fromAirtable = await this.airtable.select<AirtableModelWithId>({ 
            pages: 'all',
            filterByFormula: latestSyncTime
                ? "IS_AFTER(LAST_MODIFIED_TIME()%2C+'" + dayjs(latestSyncTime).tz('Europe/London').format('MM/DD/YYYY HH:mm') + "')"
                : undefined
        });
        this.dbg('log', `Loaded ${fromAirtable.length} entries from airtable`);

        // Remap data
        const { recordsForDb, relations } = this.airtableToDb(fromAirtable);

        // Return initial sync results
        return { recordsForDb, relations };
    }

    /*----------------------------------
    - CONVERT RECORDS
    ----------------------------------*/
    public airtableToDb( fromAirtable: AirtableModelWithId[] ) {

        // We assume that, if we use airtableToDb, it's because we received fresh data from Airtable (via REST or Webhook)
        this.airtable.master.latestSyncTimes[ this.itemName ] = dayjs().format('YYYY-MM-DD HH:mm:ss')

        const { databaseTable, dbPk } = this.dbTable();

        // No new data
        if (fromAirtable.length === 0)
            return {
                recordsForDb: [],
                relations: {},
                table: databaseTable
            }

        // 1. Index records by airtable recordId, so airtableRecordsToDb can find the PK value associated to every airtable ID
        const airtableRecordWithDbPk = this.indexRecords( fromAirtable, databaseTable );

        // 2. Convert records for the database and create delationships
        return this.airtableRecordsToDb( airtableRecordWithDbPk, databaseTable );
    }

    private indexRecords(
        fromAirtable: AirtableModelWithId[], 
        table: TMetasTable,
    ) { 
        
        const { databaseTable, dbPk } = this.dbTable();

        const airtableRecordWithDbPk: (AirtableModelWithId & { pkId: string })[] = []
        for (const record of fromAirtable) {

            const airtableId = record.recordId;
            let dbPkValue: any;

            // The PK is the airtable recordId
            if (dbPk === 'airtableId') {

                dbPkValue = airtableId;

            } else {

                // Get the PK mapper
                const pkMapper = this.mapper[dbPk];
                if (pkMapper === undefined)
                    throw new Anomaly(`The PK ${dbPk} for the table ${this.tableName} is missing in the mapper.`);

                // Get the pk value
                try {
                    dbPkValue = this.getMappedValue(dbPk, table, undefined, record);
                } catch (error) {
                    this.dbg('warn', "Excluding record", dbPk, "From index:", error, 'Excluded record:', record);
                    continue;
                }
                if (dbPkValue === undefined)
                    continue;
            }

            if (airtableId !== undefined) {
                this.airtableToDbId[ airtableId ] = dbPkValue;
                this.dbIdToAirtableId[ dbPkValue ] = airtableId;
            }

            airtableRecordWithDbPk.push({ ...record, pkId: dbPkValue });
        }
        
        this.dbg('log', `Indexed ${airtableRecordWithDbPk.length} entries by airtableId (pk: ${dbPk})`);

        return airtableRecordWithDbPk;
    }

    private airtableRecordsToDb( 
        fromAirtable: (AirtableModelWithId & { pkId?: string })[], 
        table: TMetasTable, 
    ) {

        const recordsForDb: DatabaseModel[] = []
        const relations: TRelationsIndex = {};

        // Build relationshipps
        // We do it after the recordIds were indexed, because one column can refer to the recordIId of another record of the same type
        // By exampel with a parent column
        iterateRecords:
        for (const record of fromAirtable) {

            const headhunterForDb = {
                airtableId: record.recordId,
                created: new Date(record.Created),
                updated: new Date(record.Updated),
            } as Partial<DatabaseModel>;

            // Remap datafrom Airtable for database
            iterateColumns:
            for (const dbColName in this.mapper) {
                try {

                    const value = this.getMappedValue(dbColName, table, record.pkId, record, relations);
                    if (value === undefined)
                        continue iterateColumns;
                    headhunterForDb[ dbColName ] = value;

                } catch (error) {
                     // We ignore the record from the initial index, so we remove it in the index
                     if (record.pkId !== undefined) {
                        this.dbg('info', `Delete record ${record.pkId} from the index:`, error, 'Deleted record from index:', record);
                        const dbId = this.airtableToDbId[ record.pkId ];
                        delete this.dbIdToAirtableId[ dbId ];
                        delete this.airtableToDbId[ record.pkId ];
                    }

                    continue iterateRecords;
                }
            }
            recordsForDb.push( headhunterForDb as DatabaseModel );
        }

        this.dbg('log', `${recordsForDb.length} records to insert `);

        return { recordsForDb, relations, table }
    }

    private getMappedValue( 
        dbColName: string, 
        table: TMetasTable, 
        dbPkValue: string | undefined,
        record: AirtableModelWithId,
        relations?: TRelationsIndex 
    ) {

        const mapped = this.mapper[ dbColName as keyof typeof this.mapper ];
        const dbColumn = table.colonnes[ dbColName ];
        let value: any;

        // Via airtable data
        if ('func' in mapped) {
            value = mapped.func(record)
        // Calculated value
        } else {

            value = record[ mapped.airtable ];

            if (value !== undefined && ('filter' in mapped) && mapped.filter)
                value = mapped.filter(value);
        }

        // Map to database column (data + one to one relations)
        if (dbColumn !== undefined) {

            // Check if value is provided
            if (dbColumn.optional === false && value === undefined) {
                
                // Not provided = maybe someone didn't finish to fill it
                // So we ignire this record and send a reminder on Slack
                this.reportToDevs(record, dbColName, `Mandatory data not provided.`, { value });

                if (typeof mapped.airtable === 'string')
                    this.reportToSales(record, mapped.airtable, `Please enter a value for ${mapped.airtable}`);

                this.syncStats.excluded++;
                throw new Error("Mandatory data not provided: " + dbColName);
            }

            // RecordID (airtable) => slug (database)
            if (('toOne' in mapped) && value !== undefined) {

                // Retrieve FK
                // Transform recordId into slug
                const foreignProvider = mapped.toOne();
                value = foreignProvider.getDbId( value[0], false);

                // FK not found = it hasn't been referenced
                if (value === null) {
                    // Not provided = maybe someone didn't finish to fill it
                    // So we ignire this record and send a reminder on Slack
                    const errorMsg = `The column ${dbColName} makes references to an object that wasn't indexed. 
                    Maybe this object was excluded from sync because it was incomplete.`;
                    this.reportToDevs(record, dbColName, errorMsg, { value });
                    this.syncStats.excluded++;
                    throw new Error(errorMsg);
                }
            }

            // Check if the value matches the database requirements
            const typeError = this.airtable.master.SQL.database.checkValue(value, dbColumn);
            if (typeError !== false) {
                this.reportToDevs(record, dbColName, `Invalid data type`, typeError);
                this.syncStats.excluded++;
                throw new Error("Excluded because invalid data type: " + dbColName);
            }

            // Normalize date
            if (value && dbColumn.type.js.name === 'date')
                value = new Date(value)

            // Add to the final object
            return value;

        // Other data (multiple relations)
        } else if (value !== undefined) { 

            // Just for readability
            const airtableFkValues = value;
            
            // Must be a recordIds array
            if (typeof airtableFkValues !== 'object') {
                const errorMsg = `Expected to be a list of recordIds.`;
                this.reportToDevs(record, dbColName, errorMsg, { airtableFkValues });
                this.syncStats.excluded++;
                throw new Error(errorMsg + dbColName);
            }

            // No record to process
            if (airtableFkValues.length === 0) 
                return undefined;

            if ('toMany' in mapped) {

                if (relations === undefined)
                    throw new Anomaly(`A toMany mapper has been passed to getMappedValue, but no relations index object was passed.`);

                if (dbPkValue === undefined)
                    throw new Anomaly(`A toMany mapper has been passed to getMappedValue, but no dbPkValue has been provided.`);

                // Transform recordIds (airtable) into slugs (database)
                for (const airtableFkValue of airtableFkValues) {

                    const { table, pk, fk } = mapped.toMany();

                    // FK not found = it hasn't been referenced
                    const fkVal = fk.provider.getDbId(airtableFkValue, false)
                    if (fkVal === null) {
                        // Not provided = maybe someone didn't finish to fill it
                        // So we ignire this record and send a reminder on Slackc
                        const errorMsg = `The column makes references to an object that wasn't indexed. 
                        Maybe this object was excluded from sync because it was incomplete.`
                        this.reportToDevs(record, dbColName, errorMsg, { fkVal });
                        this.syncStats.excluded++;
                        throw new Error(errorMsg + dbColName);
                    }

                    if (relations[ table ] === undefined)
                        relations[ table ] = {
                            pk: pk.key,
                            fk: fk.key,
                            values: []
                        }
                        
                    relations[ table ].values.push({
                        [pk.key]: dbPkValue,
                        [fk.key]: fkVal,
                    });
                }
            } else
                return value;
        }
    }

    /*
        TODO: Normalise / Merge with airtableRecordsToDb ?
        TODO: typings: force to have the db pk also
    */
    private dbRecordsToAirtable( records: (DatabaseModel & Relations)[] ) {

        const { databaseTable, dbPk } = this.dbTable();

        // Since we insert on airtable before in the database, here, we build the list of records for both airtable ahd the database
        const recordsForDb: DatabaseModel[] = []
        const recordsforAirtable: AirtableModel[] = []
        const relationsForDb: TRelationsIndex = {};

        for (const record of records) {

            // Get pk value for creating relation records
            const dbPkValue = record[dbPk];
            if (dbPk !== 'airtableId' && dbPkValue === undefined)
                throw new Anomaly(`A value should absolutely be provided for the pk ${dbPk}`, {
                    dbPk,
                    record
                });

            // The record we will insert into airtable + the id if provided (for update ops)
            const recordforAirtable: Partial<AirtableModel> & { id?: string } = {}
            // In case of update, we need the id
            if (record.airtableId)
                recordforAirtable.id = record.airtableId

            const recordForDb: Partial<DatabaseModel> = {
                airtableId: record.airtableId
            }

            iterateColumns:
            for (const dbKey in record) {

                const dbValue = record[dbKey];

                // We assume that there are always more validation constraints on the db model comared to the airtable model
                // And these is no validation constraint on airtable
                // So no need to validate if a required data is missing or not

                // Retirve mapper
                if (!( dbKey in this.mapper )) {
                    this.dbg("warn", `The value ${dbKey} was provided in provider.create, but is not mapped for Airtable.`);
                    recordForDb[ dbKey ] = dbValue;
                    continue iterateColumns;
                }

                // Check if value is provided
                if (dbValue === undefined) {
                    // Map to database column (data + one to one relations)
                    const dbColumn = databaseTable.colonnes[ dbKey ];
                    // Rrquired in database: Error
                    if (dbColumn?.optional === false) {
                        throw new Anomaly(`A value should absolutely be provided for the pk ${dbPk}`, {
                            dbPk,
                            record
                        });
                    // Optional: Exclude value
                    } else {
                        continue iterateColumns;
                    }
                }

                // Should clearly be mirrored to another airtable field
                const mapper = this.mapper[/* TODO: fix typing */dbKey as unknown as keyof typeof this.mapper];
                if (!(( 'airtable' in mapper ) && typeof mapper.airtable === 'string')) {
                    recordForDb[ dbKey ] = dbValue;
                    continue;
                }

                // toOne
                let airtableValue: any;
                if ('toOne' in mapper) {

                    // Get airtableId from db id
                    const foreignProvider = mapper.toOne()
                    const airtableId = foreignProvider.getAirtableId( dbValue, true)

                    airtableValue = [airtableId];
                    recordForDb[ dbKey ] = dbValue; // fk

                } else if ('toMany' in mapper) {

                    // Check format
                    if (!Array.isArray( dbValue ))
                        throw new Anomaly(`The values mapped as toMany should be arrays of ids, which is not the case of the value provided as ${dbKey}.`, {
                            dbKey,
                            dbValue,
                        });

                    // Index relationship
                    const { table, pk, fk } = mapper.toMany()
                    if (relationsForDb[ table ] === undefined)
                        relationsForDb[ table ] = {
                            pk: pk.key,
                            fk: fk.key,
                            values: []
                        }

                    // Get airtableIds from db ids
                    airtableValue = []
                    for (const dbFk of dbValue) {

                        const airtablePkValue = fk.provider.getAirtableId(dbFk, true);

                        // Airtable
                        airtableValue.push( airtablePkValue );
                        
                        // Database
                        relationsForDb[ table ].values.push({
                            [pk.key]: dbPkValue,
                            [fk.key]: dbFk,
                        });
                    }

                } else {

                    // Map value
                    airtableValue = dbValue;
                    recordForDb[ dbKey ] = dbValue;

                    // Correct value
                    const dbCol = this.airtable.tableMetas?.fields[ mapper.airtable ]
                    if (dbCol?.type === 'date')
                        airtableValue = dayjs(airtableValue).format('YYYY-MM-DD')
                    else if (dbCol?.type === 'dateTime')
                        airtableValue = dayjs(airtableValue).format('YYYY-MM-DD HH:mm:ss')

                }

                recordforAirtable[ mapper.airtable ] = airtableValue;
            }

            recordsforAirtable.push(recordforAirtable);
            recordsForDb.push(recordForDb);
        }

        return {
            recordsforAirtable,
            recordsForDb,
            relationsForDb,
        }
    }

    /*----------------------------------
    - PERSIST TO DATABASE
    ----------------------------------*/
    public async toDatabase({ records, relations }: TUpdatedData<DatabaseModel>) {
        
        // New / Updated records
        // We do one per one to improve debuggability
        for (const record of records) {

            const upsertResult = await this.airtable.master.SQL.upsert<SyncableDatabaseRecord>(this.tableName, record, {
                '*': true,
                updated: new Date
            });
            //this.dbg('log', `Inserted records in ${this.tableName}`, upsertResult);
            this.syncStats.upserted += upsertResult.affectedRows;
        }

        await this.updateRelations(relations);

        await this.deleteOldRecords();

        return this.airtableToDbId;
    }

    // TODO: Move to core database
    public async updateRelations( relations: TRelationsIndex, insertedId?: string ) {
        for (const relationTableName in relations) {
            const relationRecords = relations[relationTableName];

            // Check if not empty
            if (relationRecords.values.length === 0)
                continue;

            // Create new
            const upsertResult = await this.airtable.master.SQL.upsert(relationTableName, relationRecords.values, '*', {
                /*bulk: false, // Easied to debug if every row is inserted in a distinct query
                log: true*/
            });
            this.dbg('log', `Tried to upsert ${relationRecords.values.length} records in ${relationTableName}, upserted in reality:`, upsertResult);
            this.syncStats.upsertedRelations += upsertResult.affectedRows;

            // Create list of relation ey so we can define which records to delete
            let pkVals: string[] = [], fkVals: string[] = [];
            for (const record of relationRecords.values) {

                let pkVal = record[ relationRecords.pk ]

                pkVals.push( pkVal );
                fkVals.push( record[ relationRecords.fk ] );
            }

            // Delete old
            //this.dbg('log', "DELETE OLD RELATIONS", relations)
            const deleteResult = await this.airtable.master.SQL`
                DELETE FROM :${relationTableName}
                WHERE 
                    :${relationRecords.pk} IN (${pkVals})
                    AND
                    :${relationRecords.fk} NOT IN (${fkVals})
            `.run();
            this.syncStats.deletedRelations += deleteResult.affectedRows;
        }
    }

    private async deleteOldRecords() {

        // Retrieve the list of record to delete
        const existingRecordsIds: string[] = Object.keys(this.airtableToDbId)
        const toDelete = await this.airtable.master.SQL<DatabaseModel>`
            SELECT *
            FROM :${this.tableName}
            WHERE airtableId NOT IN (${existingRecordsIds})
        `.all();

        // Nothing to do
        if (toDelete.length === 0)
            return;

        // Update stats
        this.dbg('log', LogPrefix, "toDelete", this.tableName, toDelete);
        this.syncStats.deleted += toDelete.length;
        this.deletedList.push( ...toDelete );
        // TODO: Backup this.deletedLis

        // Delete
        const deleteResult = await this.airtable.master.SQL`
            DELETE FROM :${this.tableName}
            WHERE airtableId NOT IN (${existingRecordsIds})
        `.run();

        this.dbg('log', "Delete result:", deleteResult);
        // NOTE: Delete relationhip = done automatically thanks to MySQL foreign keys
    }
    
    /*----------------------------------
    - WRITE OPERATIONS
    ----------------------------------*/

    /*
        NOTE: Known limitations:
        - Only the mirrored field are supported (excluding relations and functions)
        - We ony write before aitable and then database, because database can be serynced from airtable

        TODO: typings: force to have the db pk also
    */
    public async create( 
        record: DatabaseModel & Relations,
        airtableRecord: Partial<AirtableModel> = {}
    ) {

        this.dbg('log', `Create record`, record);

        // Disable write operations when the Airtable sevrice is disabled
        if (this.airtable.master.config.enable === false)
            throw new Error("Write operations are disabled since Airtable service is not enabled.");

        // Remap for airtable
        // Only one insert supported for now
        // ? Does airtable returns the array of creatd records IN THE SAME ORDER than the input records array ?
        const { recordsforAirtable, recordsForDb, relationsForDb } = this.dbRecordsToAirtable([record]);
        const recordForDatabase = recordsForDb[0];
        const recordforAirtable = { ...recordsforAirtable[0], ...airtableRecord };

        // Insert to airtable
        this.dbg('log', `Insert into airtable`, recordforAirtable);
        const insertedAirtable = await this.airtable.insert([ recordforAirtable as AirtableModel ])
        const airtableId = insertedAirtable.records[0]?.id;
        this.dbg('log', `Inserted into airtable`, insertedAirtable);
        const recordUrl = this.getRecordUrl(airtableId);

        if (!airtableId)
            throw new Anomaly(`Couldn't retrieve the recordId of the inserted record.`, {
                insertResponse: insertedAirtable,
                triedToInsert: recordforAirtable
            });

        // Insert into database
        const recordforDatabaseWithAirtableId = {
            ...recordForDatabase,
            airtableId,
        }
        this.dbg('log', `Insert into database`, recordforDatabaseWithAirtableId);
        const insertedDb = await this.airtable.master.SQL.insert( this.tableName, recordforDatabaseWithAirtableId);
        const { databaseTable, dbPk } = this.dbTable();
        const dbPkValue = recordforDatabaseWithAirtableId[ dbPk ];
        if (dbPkValue === undefined)
            throw new Anomaly(`Couldn't retrieve the database pk ${databaseTable}.${dbPk} because it's uèndefined. The pk isn't supposed to be undefined here.`, {
                dbPk,
                recordforDatabaseWithAirtableId
            });
        this.dbg('log', `Inserted into database`, insertedDb);

        // Update iondexes
        this.airtableToDbId[ airtableId ] = dbPkValue;
        this.dbIdToAirtableId[ dbPkValue ] = airtableId;

        // Update relations
        for (const relationTableName in relationsForDb) {
            const relationRecords = relationsForDb[relationTableName];
            for (const record of relationRecords.values) {
                record[ relationRecords.pk ]  = airtableId
            }
        }
        await this.updateRelations(relationsForDb);

        return { ...recordforDatabaseWithAirtableId, recordUrl }
    }

    /*
        - We ony write before aitable and then database, because database can be serynced from airtable
        TODO: typings: force to have the db pk also
    */
    public async update( 
        records: (With<DatabaseModel, 'airtableId' & Relations>)[], 
        simulate: boolean = false 
    ) {

        // Disable write operations when the Airtable sevrice is disabled
        if (this.airtable.master.config.enable === false)
            throw new Error("Write operations are disabled since Airtable service is not enabled.");

        // Remap for airtable
        const {
            recordsForDb,
            relationsForDb,
            recordsforAirtable,
        } = this.dbRecordsToAirtable(/* TODO: Fix With<> */ records );

        if (simulate) {
            this.dbg('log', `Update from provider ${this.itemName}:`, {
                recordsForDb,
                relationsForDb,
                recordsforAirtable,
            });
            return;
        }

        if (this.airtable.master.config.enableSync && this.airtable.master.config.enableUpdate) {
            // Update to Airtable
            this.dbg('log', `Update into airtable`, recordsforAirtable);
            const updatedAirtable = await this.airtable.update( recordsforAirtable );
            this.dbg('log', `Updated into airtable`, updatedAirtable);
        } else
            this.dbg('warn', LogPrefix, "Cancelled update on airtable");

        // Update to Database
        //this.dbg('log', `Update into database`, records);
        const updatedDb = await this.airtable.master.SQL.update( this.tableName, recordsForDb, ['airtableId']);
        //this.dbg('log', `Updated into database`, updatedDb);

        // Persist relations
        await this.updateRelations(relationsForDb);
    }

     /*
        - We ony write before aitable and then database, because database can be serynced from airtable
    */
    public async delete(...recordIds: string[]) {

        // Disable write operations when the Airtable sevrice is disabled
        if (this.airtable.master.config.enable === false)
            throw new Error("Write operations are disabled since Airtable service is not enabled.");

        throw new Error("Feature not implemented");

    }

    /*----------------------------------
    - REPORTING
    ----------------------------------*/

    public getRecordUrl( recordId: string ) {
        return `https://airtable.com/${this.airtable.baseId}/${this.airtable.tableMetas?.id}/${recordId}?copyLinkToCellOrRecordOrigin=gridView&blocks=hide`
    }

    private dbg( type: 'log'|'warn'|'info'|'error', ...args: any[] ) {

        if (type !== 'error' && !this.airtable.master.config.debug)
            return;

        console[type]( LogPrefix, `[${this.itemName}]`, ...args);
    }

    public reportToDevs( record: AirtableModelWithId, dbFieldName: string, error: string, debugData?: {}) {

        if (this.syncErrors[ record.recordId ] === undefined)
            this.syncErrors[ record.recordId ] = { record, fields: {} }

        this.syncErrors[  record.recordId  ].fields[ dbFieldName ] = {
            error,
            data: debugData
        }
    }

    public reportToSales( record: AirtableModelWithId | 'METAS', airtableFieldName: string, message: string ) {

        const id = record === 'METAS' ? record : record.recordId;

        if (this.errorsForSales[ id ] === undefined)
            this.errorsForSales[ id ] = {
                record, 
                fields: {}
            }

        this.errorsForSales[ id  ].fields[ airtableFieldName ] = {
            iterations: 0,
            error: message
        }
    }

    public fixError( record: AirtableModelWithId, fieldNames?: string[] ) {

        this.dbg('log', "fixError", record.recordId, fieldNames);

        if (this.errorsForSales[ record.recordId ] === undefined)
            return;

        if (fieldNames === undefined) {
            this.dbg('log', LogPrefix, `All errors fixed for ${record.recordId}`);
            delete this.errorsForSales[ record.recordId ];
            return;
        }

        for (const fieldName of fieldNames) 
            if (this.errorsForSales[ record.recordId ][ fieldName ] !== undefined) {
                this.dbg('log', LogPrefix, `Error fixed for ${record.recordId}.${fieldName}`);
                delete this.errorsForSales[ record.recordId ][ fieldName ];
            }
    }

    public getSyncResults() {

        const results = {
            stats: this.syncStats,
            deleted: this.deletedList,
            errors: this.syncErrors,
            errorsForSales: this.errorsForSales
        }

        // We remove error message only once they're fixed (via webhooks)

        // Reset stats
        this.deletedList = []
        this.syncErrors = {}
        this.syncStats = {
            fromAirtable: 0,

            inserted: 0,
            updated: 0,
            excluded: 0,
            upserted: 0,
            deleted: 0,

            upsertedRelations: 0,
            deletedRelations: 0,

            errors: 0
        }

        return results
    }
}