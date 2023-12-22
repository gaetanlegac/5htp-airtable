/*----------------------------------
- TYPES
----------------------------------*/

export type TProviderAction = 'create'|'update'|'delete'

export type SyncableDatabaseRecord = {
    airtableId?: string,
    created?: Date,
    updated?: Date,
    synced?: Date
}

export type TAirtableModel = {
    Created: Date,
    Updated: Date,
}

export type With<
    TObject,
    TRequired extends (keyof TObject) | {[key in keyof TObject]?: any},
    TAdditionnal extends {[key: string]: any} = {}
> = (
    Omit<TObject, TRequired extends (keyof TObject) ? TRequired : keyof TRequired> 
    & 
    (TRequired extends (keyof TObject) ? Required<Pick<TObject, TRequired>> : TRequired)
    &
    TAdditionnal
)

/*----------------------------------
- INTERFACE
----------------------------------*/
export default interface ProviderInterface<
    AirtableModel extends TAirtableModel = TAirtableModel,
    DatabaseModel extends SyncableDatabaseRecord = SyncableDatabaseRecord,
    Relations extends {} = {}
> {

    create( 
        record: DatabaseModel & Relations,
        airtableRecord: Partial<AirtableModel>
    ): Promise<{}>;

    update( 
        records: (With<DatabaseModel, 'airtableId' & Relations>)[], 
        simulate: boolean
    ): Promise<void>;

    delete(...recordIds: string[]): Promise<void>;

}