# Airtable Sync for 5HTP

5HTP Service to integrate Airtable API and synchronise it with MySQL tables

[![npm](https://img.shields.io/npm/v/5htp-airtable)](https://www.npmjs.com/package/5htp-airtable)

## Installation

```bash
npm install --save 5htp-airtable
```

## Features

- Initial sync (differential)
- Realtime sync (websocket)
- Support for relationships: one to one, one to many, many to many
- Perfectly integrated with the 5HTP framework

## How it works

To be done

## How to sync your Airtable table with a MySQL table

### 1. Create your data provider

```typescript
/*----------------------------------
- DEPENDANCES
----------------------------------*/

// App
import { Airtable, Hub } from '@app';
import DataProvider, { TAirtableMapper } from '5htp-airtable/provider';

/*----------------------------------
- TYPES
----------------------------------*/

type UserFromAirtable = {

    // Identity
    'First Name': string,
    'Last Name': string,
    'Country': string[],
    'Languages': string[],
    'Password'?: string,

    // Contact Info
    'Email': string,
    'Phone Number': string,
    'LinkedIn URL': string,

    // Synced Table
    'Created': Date,
    'Updated': Date
}

type UserRelations = {
    languages: string[],
}

/*----------------------------------
- PROVIDER
----------------------------------*/
export default class UserProvider extends DataProvider<UserFromAirtable, User, UserRelations> {

    public constructor( public users: UserService, public app = users.app ) {
        super(app, 'users');
        
        // Register to Airtable service + load airtable & db table metadatas
        Airtable.registerProvider(this);
    }

    // Input
    public airtable = Airtable.table('myAirtableBase', 'myAirtableTable');
    // All the required fields in User database table should be mapped here
    // So we ensure that after the mapping, we upsert the minimum required values
    public mapper: TAirtableMapper<UserFromAirtable, User, UserRelations> = {

        // Identoty
        'firstName': {
            airtable: 'First Name',
        },
        'lastName': {
            airtable: 'Last Name',
        },
        'country': {
            airtable: 'Country',
            toOne: () => Hub.geolocations
        },
        'languages': {
            airtable: 'Languages',
            toMany: () => ({
                table: 'UserLanguage',
                pk: {
                    key: 'headhunter',
                },
                fk: {
                    key: 'language',
                    provider: Hub.languages,
                }
            })
        },
        'password': {
            airtable: 'Password',
        },
    }

    // Database table name
    public tableName = 'User';
}
```

### 2. How to use your provider

```typescript
import UserProvider from './provider';

export default class UsersService extends Service {

    // 1. Instanciate Provider
    public provider = new UserProvider(this);

    public async start() {
        // 2. Ensure the database is sync with Airtable
        await this.provider.sync();
    }

    public async signup( newUser: User, request: Request ) {
        // 3. Insert new data on both Airtable and Database
        const inserted = await this.provider.create({
            ...newUser,
            password: sha1(newUser.password),
        });
    }

    public async resetPassword( 
        type: string, 
        token: string, 
        rawPassword: string,
    ) {
        // 4. Update data on both Airtable and Database
        await this.provider.update([{
            airtableId: user.airtableId,
            email: email,
            password: sha1(rawPassword)
        }]);
    }
}
```

### Use it remotely

To be done

## Changelog

### 0.1.0 (26/03/2024)

* Remote Providers
    - Bug fixes
    - Improve security by requiring a token
* Writing the sync() method in the provider is now optional (but can be overwritten if you need to call special actions after sync)
* Simplified readme
* Fix issue when the DB table pk is airtableId
* Update database implementation to 5HTP 0.3.8
* Added more logs

### 0.0.9 (22/12/2023)

* Possibility to create RemoteProviders

## To be done

[] Fix typings
[] Import typings from 5htp-core (peerdeps)
[] Tests
[] Usage doc