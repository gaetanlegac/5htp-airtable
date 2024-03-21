/*----------------------------------
- DEPS
----------------------------------*/

// Specific
import type { TQueryOptions } from '..';

/*----------------------------------
- TYPES: REQUEST
----------------------------------*/

export type TProviderAction = 'select'|'upsert'|'insert'|'update'|'delete'

export type TSelectOptions = {
    pages?: number | 'all',
    filterByFormula?: string
}

export type TMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'

export type TQueryDataObj = {[k: string]: any}

/*----------------------------------
- TYPES: RESULTS
----------------------------------*/

export type TRecordFields = {[k: string]: TAirtableCellData}
export type TRecordFieldsWithId = TRecordFields & { id: string }
export type TAirtableCellData = string | number | boolean | undefined | TAirtableCellData[];

export type TListResult<TRecordtype extends TRecordFields> = {
    records: TAirtableRecord<TRecordtype>[],
    offset?: string
}

export type TCreateResult<TRecordtype extends TRecordFields> = {
    records: TAirtableRecord<TRecordtype>[]
}

export type TUpdateResult<TRecordtype extends TRecordFields> = {
    records: TAirtableRecord<TRecordtype>[]
}

export type TDeleteResult<TRecordIdToDelete extends string> = {
    records: {
        id: TRecordIdToDelete,
        deleted: boolean
    }[]
}

export type TAirtableRecord<TRecord extends any> = {
    id: string,
    createdTime: string,
    fields: TRecord
}

export type TResultRecord<TRecord extends TRecordFields> = TRecord & {
    recordId: string
}

/*----------------------------------
- INTERFACE
----------------------------------*/
export default abstract class AirtableTableInterface {

    // https://airtable.com/developers/web/api/create-records
    public abstract upsert<TRecord extends TRecordFields>( 
        data: TRecord[],
        idFields: (keyof TRecord)[],
    ): Promise< TCreateResult<TRecord> >;

    // https://airtable.com/developers/web/api/create-records
    public abstract insert<TRecord extends TRecordFields>( 
        data: TRecord[],
    ): Promise< TCreateResult<TRecord> >;

    // https://airtable.com/developers/web/api/update-multiple-records

    public abstract update<TRecord extends TRecordFieldsWithId>( 
        recordsToUpdate: TRecord[]
    ): Promise< TCreateResult<TRecord> >;

    public abstract update<TRecord extends TRecordFields>( 
        recordsToUpdate: TRecord[],
        upsertIds: (keyof TRecord)[]
    ): Promise< TCreateResult<TRecord> >;

    public abstract update<TRecord extends TRecordFields>( 
        recordsToUpdate: TRecord[],
        upsertIds?: (keyof TRecord)[]
    ): Promise< TCreateResult<TRecord> >;

    // https://airtable.com/developers/web/api/delete-multiple-records
    public abstract delete<TRecordIdToDelete extends string>( 
        recordIds: TRecordIdToDelete[]
    ): Promise<unknown>;
}