/*----------------------------------
- DEPS
----------------------------------*/

// Local
import type RemoteProvider from '../provider/remote';

import AirtableTableInterface, { 
    TProviderAction,
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

// 5HTP framework
import type Application from '5htp-core/src/server/app';
import type FetchService from '5htp-core/src/server/services/fetch';

/*----------------------------------
- CLASS
----------------------------------*/
export default class AirtableTable extends AirtableTableInterface {

    public constructor(
        public provider: RemoteProvider,
        private app = provider.app
    ) {
        super();
    }

    // https://airtable.com/developers/web/api/create-records
    public upsert<TRecord extends TRecordFields>( 
        data: TRecord[],
        idFields: (keyof TRecord)[],
    ): Promise< TCreateResult<TRecord> > {
        return this.sendRequest('upsert', { data, idFields });
    }

    // https://airtable.com/developers/web/api/create-records
    public insert<TRecord extends TRecordFields>( 
        data: TRecord[],
    ): Promise< TCreateResult<TRecord> > {
        return this.sendRequest('insert', { data });
    }

    // https://airtable.com/developers/web/api/update-multiple-records

    public update<TRecord extends TRecordFields>( 
        recordsToUpdate: TRecord[],
        upsertIds?: (keyof TRecord)[]
    ): Promise< TCreateResult<TRecord> > {
        return this.sendRequest('update', { recordsToUpdate, upsertIds });
    }

    // https://airtable.com/developers/web/api/delete-multiple-records
    public delete<TRecordIdToDelete extends string>( 
        recordIds: TRecordIdToDelete[]
    ): Promise<unknown> {
        return this.sendRequest('delete', { recordIds });
    }

    private sendRequest( action: TProviderAction, data: any ) {
        return this.app.Fetch.post( this.provider.providerHost, { 
            airtableOnly: true,
            providerId: this.provider.providerId,
            action, 
            data 
        });
    }

}