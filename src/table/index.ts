/*----------------------------------
- DEPENDANCES
----------------------------------*/

// Npm

// Core
import { arrayChunks } from '@common/data/tableaux';

// Specific
import type { 
    default as AirtableService, 
    TConfig, TTableMetadatas, TQueryOptions 
} from '..';

import AirtableTableInterface, { 
    // Options
    TMethod, TQueryDataObj, TSelectOptions, 
    // Records
    TRecordFields, TRecordFieldsWithId, 
    // Results
    TCreateResult, TDeleteResult, TListResult, TUpdateResult, TResultRecord
} from './interface';

/*----------------------------------
- TYPES
----------------------------------*/

/*----------------------------------
- CONFIG
----------------------------------*/

const LogPrefix = '[airtable]';

/*----------------------------------
- CLASS
----------------------------------*/
export default class AirtableTable<Config extends TConfig = TConfig> extends AirtableTableInterface {

    public tablePath: string;
    public tableMetas?: TTableMetadatas;

    public baseId: string;

    public constructor(
        public master: AirtableService<Config>, 
        public baseName: string,//keyof Config["spaces"],
        public table: string,
        private config = master.config,
    ) {

        super();

        this.tablePath = baseName + '.' + table;

        const baseId = this.config.spaces[ baseName ];
        if (baseId === undefined)
            throw new Error( LogPrefix + ` Space name ${baseName} no found in this.config.spaces.`);
        this.baseId = baseId;

    }

    private log(...args: any[]) {
        return this.config.debug && console.log( LogPrefix + `[${this.tablePath}][${this.table}]`, ...args);
    }

    public metadatas() {

        if (this.tableMetas === undefined)
            throw new Error(`Tried to get metadatas for airtable table ${this.tablePath}, but no metas were gived to this.tableMetas.`);
    
        return this.tableMetas;
    }

    // https://airtable.com/developers/web/api/list-records
    public async select<TRecord extends TRecordFields>( 
        options: TSelectOptions = {}
    ): Promise<TResultRecord<TRecord>[]> {

        // Create query otpions
        const queryOptions: TQueryOptions = {}
        // In filterByFormula, we need to preserve some characters which are automatically
        //  url encoded if we pass it to the data param
        if (options.filterByFormula !== undefined)
            queryOptions.urlSuffix = 'filterByFormula=' + options.filterByFormula;

        // Context
        const results: (TRecord & { recordId: string })[] = [];
        let offset: string | undefined;
        let curPage: number = 1;

        // Iterate pages
        do {

            this.log(`Retrieve page ${curPage} for ${this.tablePath}`);
            const pageResults = await this.query<TRecord>('GET', {
                // Page offset
                ...(offset !== undefined ? { offset } : {}),
            }, queryOptions);
            this.log(`Retrieved airtable record: `, pageResults.records.length);

            // Process response
            offset = pageResults.offset;
            const resultsWithId = pageResults.records.map( r => ({ ...r.fields, recordId: r.id }))
            results.push( ...resultsWithId );

            curPage++;

        } while (
            
            offset !== undefined 
            && 
            options.pages !== undefined 
            && 
            (options.pages === 'all' || curPage < options.pages)
        );

        return results;
    }

    // https://airtable.com/developers/web/api/create-records
    public upsert<TRecord extends TRecordFields>( 
        data: TRecord[],
        idFields: (keyof TRecord)[],
    ): Promise< TCreateResult<TRecord> > {
        return this.update( data, idFields);
    }

    // https://airtable.com/developers/web/api/create-records
    public async insert<TRecord extends TRecordFields>( 
        data: TRecord[],
    ): Promise< TCreateResult<TRecord> > {

        const mergedResults: TCreateResult<TRecord> = {
            records: []
        }

        // Insertions are limited to 10 record for each API call
        const chunks = arrayChunks(data, 10);
        for (let i = 0; i < chunks.length; i++) {

            const chunk = chunks[i];
            this.log(`Inserting chunk ${i} (${chunk.length} records)`);
            
            const result = await this.query<TRecord>('POST', {
                // Record to insert
                records: chunk.map( fields => ({ fields })),
            }).then((res) => {
                this.log(`Added airtable record: `, res);
                return res;
            })

            mergedResults.records.push(...result.records);
        }

        return mergedResults;
    }

    // https://airtable.com/developers/web/api/update-multiple-records

    public async update<TRecord extends TRecordFieldsWithId>( 
        recordsToUpdate: TRecord[]
    ): Promise< TCreateResult<TRecord> >;

    public async update<TRecord extends TRecordFields>( 
        recordsToUpdate: TRecord[],
        upsertIds: (keyof TRecord)[]
    ): Promise< TCreateResult<TRecord> >;

    public async update<TRecord extends TRecordFields>( 
        recordsToUpdate: TRecord[],
        upsertIds?: (keyof TRecord)[]
    ) {

        const mergedResults: TCreateResult<TRecord> = {
            records: []
        }

        // Updated are limited to 10 record for each API call
        const chunks = arrayChunks(recordsToUpdate, 10);
        for (let i = 0; i < chunks.length; i++) {

            const chunk = chunks[i];
            this.log(`Updating chunk ${i} (${chunk.length} records)`);

            const result = await this.query<TRecord>('PATCH', {
                // Record to update
                records: chunk.map(({ id, ...fields }) => ({ id, fields })),
                // Upsert: https://community.airtable.com/t5/development-apis/new-beta-rest-api-upserts/td-p/51628
                performUpsert: upsertIds ? {
                    // List of unique IDs (if upsert)
                    fieldsToMergeOn: upsertIds
                } : undefined
            }).then((res) => {
                this.log(`Updated ${chunk.length} airtable records: `);
                return res;
            })

            mergedResults.records.push(...result.records);
        }

        this.log(`Updated ${recordsToUpdate.length} airtable records`);

        return mergedResults;
    }

    // https://airtable.com/developers/web/api/delete-multiple-records
    public delete<TRecordIdToDelete extends string>( 
        recordIds: TRecordIdToDelete[]
    ): Promise<TDeleteResult<TRecordIdToDelete>> {
        return this.query<TRecordIdToDelete>('DELETE', {
            records: recordIds
        }).then((res) => {
            this.log(`Deleted ${recordIds.length} airtable records.`);
            return res;
        })
    }

    protected query<TRecord extends TRecordFields>( 
        method: 'GET', data?: TQueryDataObj, options?: TQueryOptions
    ): Promise<TListResult<TRecord>>;
        
    protected query<TRecord extends TRecordFields>( 
        method: 'POST', data?: TQueryDataObj, options?: TQueryOptions
    ): Promise<TCreateResult<TRecord>>;

    protected query<TRecord extends TRecordFields>( 
        method: 'PATCH', data?: TQueryDataObj, options?: TQueryOptions
    ): Promise<TUpdateResult<TRecord>>;

    protected query<TRecordIdToDelete extends string>( 
        method: 'DELETE', data?: TQueryDataObj, options?: TQueryOptions
    ): Promise<TDeleteResult<TRecordIdToDelete>>;

    protected query<TRecord extends TRecordFields>( 
        method: TMethod, data?: TQueryDataObj, options: TQueryOptions = {}
    ): Promise<TRecord> {

        // Build URL
        let url = "/v0/" + this.baseId + "/" + encodeURI(this.table);
        
        // Run request
        return this.master.query(method, url, data, options);
    }
}