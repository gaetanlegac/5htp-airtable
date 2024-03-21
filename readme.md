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

    public constructor(
        public users: UserManager,
        public app = users.app
    ) {
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

    // Initial sync
    public async sync() {

        // Sync latest changes from Airtable
        const updated = await this.viaAirtable();
        // If these are updated on Airtable, transmiss those updates to database
        if (updated)
            await this.toDatabase(updated);
    }
}
```

### 2. How to use your provider

```typescript
/*----------------------------------
- DEPENDANCES
----------------------------------*/

// ?pm
import sha1 from 'sha1';
// Core
import { InputError, Forbidden } from '@common/errors';
// App
import { SQL, Router } from '@app';
// Specific
import UserProvider from './provider';

/*----------------------------------
- SERVICE TYPES
----------------------------------*/

export type User = {
    firstName: string,
    lastName: string,
    country: string,
    languages: string[],
    password: string,
}

/*----------------------------------
- CLASS
----------------------------------*/
export default class HeadhunterManager {

    // Data management
    public provider = new UserProvider(this);
    
    public constructor(  
        public app = headhunting.app,
    ) {}

    public async start() {
        // Sync data from Airtable
        await this.provider.sync();
    }

    /*----------------------------------
    - SIGNUP
    ----------------------------------*/
    public async emailExists( email: string ) {
        return await SQL.exists(`FROM User WHERE email = ${SQL.esc( email )}`)
    }

    public async signup( newUser: User, request: Request ) {

        // Check if email exists before
        const exists = await this.emailExists(newUser.email);
        if (exists) 
            throw new InputError(`An acount already exists with this email.`);

        // Save to Airtable
        const inserted = await this.provider.create({
            ...newUser,
            password: sha1(newUser.password),
        });

        await Users.createSession({ email: newUser.email }, request);

        // Login
        return {
            redirectUrl: Router.url('/onboarding'),
            user: newUser
        }
    }

    /*----------------------------------
    - LOGIN
    ----------------------------------*/

    public async resetPassword( 
        type: string, 
        token: string, 
        rawPassword: string,
    ) {

        // Decrypt token to email
        const email = Users.decodeToken(token);

        // Retrve acount information
        const user = await SQL`
            SELECT 
                password, 
                CONCAT(firstName, ' ', lastName) as fullName,
                airtableId
            FROM User WHERE email = ${email};
        `.firstOrFail("This account doesn't exists.");

        // Update the account password if it exists
        await this.provider.update([{
            airtableId: user.airtableId,
            email: email,
            password: sha1(rawPassword)
        }]);

        // Redirect
        return true;

    }
}
```

### Use it remotely

To be done

## Changelog

### 0.1.0 (21/03/2024)

* Remote Providers
    - Bug fixes
    - Improve security by requiring a token

### 0.0.9 (22/12/2023)

* Possibility to create RemoteProviders

## To be done

[] Fix typings
[] Import typings from 5htp-core (peerdeps)
[] Tests
[] Usage doc