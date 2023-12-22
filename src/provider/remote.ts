/*----------------------------------
- DEPS
----------------------------------*/

// Local
import ProviderInterface, {
    TAirtableModel,
    SyncableDatabaseRecord,
    With,
    TProviderAction
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
export default class RemoteProvider<
    AirtableModel extends TAirtableModel = TAirtableModel,
    DatabaseModel extends SyncableDatabaseRecord = SyncableDatabaseRecord,
    Relations extends {} = {}
> implements ProviderInterface {

    public constructor(
        public app: Application & { Fetch: FetchService },
        public providerHost: string,
        public providerId: string
    ) {

    }

    public create( 
        record: DatabaseModel & Relations,
        airtableRecord: Partial<AirtableModel> = {}
    ) {
        return this.sendRequest('create', { record, airtableRecord });
    }

    public update( 
        records: (With<DatabaseModel, 'airtableId' & Relations>)[], 
        simulate: boolean = false
    ): Promise<void> {
        return this.sendRequest('update', { records, simulate });
    }

    public delete( ...recordIds: string[] ): Promise<void> {
        return this.sendRequest('delete', { recordIds });
    }

    private sendRequest( action: TProviderAction, data: any ) {
        return this.app.Fetch.post( this.providerHost, { 
            providerId: this.providerId,
            action, 
            data 
        });
    }

}