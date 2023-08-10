/*----------------------------------
- TYPES
----------------------------------*/

// Core
import type { TMetasColonne as DatabaseColumn } from '@server/services/database/metas';

// App
import type { 
    TRawFieldMetadata as AirtableColumnMetas
} from '.';

/*----------------------------------
- TYPES
----------------------------------*/
// https://airtable.com/api/meta
export type TFieldType = 'multipleAttachments'|'multipleLookupValues'|'autoNumber'|'checkbox'|'count'|'createdTime'|'currency'|'date'|'dateTime'|'duration'|'email'|'formula'|'lastModifiedTime'|'multilineText'|'multipleRecordLinks'|'multipleSelects'|'number'|'percent'|'phoneNumber'|'rating'|'richText'|'rollup'|'singleLineText'|'singleSelect'|'url'

export type TTypeHelper = {
    toV1?: (v2Value: unknown) => any,
    hasCompatibilityError: (
        airtableCol: AirtableColumnMetas, 
        databaseCol: DatabaseColumn 
    ) => string | boolean
}

type TAirtableFieldHelpers = {
    [typeName in TFieldType]: TTypeHelper
}

/*----------------------------------
- CONST
----------------------------------*/
// https://airtable.com/developers/web/api/field-model
const typeHelpers: TAirtableFieldHelpers = {
    /*----------------------------------
    - CHOICES
    ----------------------------------*/
    // https://airtable.com/developers/web/api/field-model#select
    // WARN: null when empty
    singleSelect: {
        toV1: (v2Value: { name: string } | null) => v2Value?.name,
        hasCompatibilityError: (airtableCol, databaseCol) => {

            // Choices restricted on Airtable, but not on the database
            if (databaseCol.type.js.name === 'string')
                return false;

            // Type compatibility
            if (databaseCol.type.js.name !== 'enum')
                return true;

            const dbEnumChoices = databaseCol.type.sql.params;
            if (dbEnumChoices === undefined)
                return 'No possible values were defined for the database column.';

            // If all the possible values from airtable are include din the database
            for (const choice of airtableCol.options.choices)
                if (!dbEnumChoices.includes( choice.name ))
                    return `The value "${choice.name}" is possible on airtable, but not on the database. Values possible in db: ${dbEnumChoices.join(', ')}`;

            return false;
        }
    },
    // https://airtable.com/developers/web/api/field-model#multiselect
    // WARN: null when empty
    multipleSelects: {
        toV1: (v2Value: { name: string }[] | null) => v2Value?.map(v => v.name),
        hasCompatibilityError: (airtableCol, databaseCol) => {

            // Type compatibility
            if (databaseCol.type.js.name !== 'array')
                return true;

            // Choices restricted on Airtable, but not on the database
            const dbArrayChoices = databaseCol.type.sql.params;
            if (dbArrayChoices === undefined)
                return false;

            // If all the possible values from airtable are include din the database
            for (const choice of airtableCol.options.choices)
                if (!dbArrayChoices.includes( choice.name ))
                    return `The value "${choice.name}" is possible on airtable, but not on the database. Values possible in db: ${dbArrayChoices.join(', ')}`;

            return false;
        }
    },

    /*----------------------------------
    - INT
    ----------------------------------*/
    autoNumber: {
        hasCompatibilityError: (airtableCol, databaseCol) => databaseCol.type.js.name !== 'int',
    },
    count: {
        hasCompatibilityError: (airtableCol, databaseCol) => databaseCol.type.js.name !== 'int',
    },
    duration: {
        hasCompatibilityError: (airtableCol, databaseCol) => databaseCol.type.js.name !== 'int',
    },

    /*----------------------------------
    - FLOATS OR Int
    ----------------------------------*/
    currency: {
        hasCompatibilityError: (airtableCol, databaseCol) => 
            databaseCol.type.js.name !== 'float' && databaseCol.type.js.name !== 'int',
    },
    number: {
        hasCompatibilityError: (airtableCol, databaseCol) => 
            databaseCol.type.js.name !== 'float' && databaseCol.type.js.name !== 'int',
    },
    percent: {
        hasCompatibilityError: (airtableCol, databaseCol) => 
            databaseCol.type.js.name !== 'float' && databaseCol.type.js.name !== 'int',
    },
    rating: {
        hasCompatibilityError: (airtableCol, databaseCol) => 
            databaseCol.type.js.name !== 'float' && databaseCol.type.js.name !== 'int',
    },

    /*----------------------------------
    - BOOL
    ----------------------------------*/
    // https://airtable.com/developers/web/api/field-model#checkbox
    checkbox: {
        toV1: (v2Value: true | null) => v2Value === true,
        hasCompatibilityError: (airtableCol, databaseCol) => databaseCol.type.js.name !== 'int' // TODO: boolean
    },

    /*----------------------------------
    - DATE
    ----------------------------------*/
    createdTime: {
        hasCompatibilityError: (airtableCol, databaseCol) => databaseCol.type.js.name !== 'date',
    },
    date: {
        hasCompatibilityError: (airtableCol, databaseCol) => databaseCol.type.js.name !== 'date',
    },
    dateTime: {
        hasCompatibilityError: (airtableCol, databaseCol) => databaseCol.type.js.name !== 'date',
    },
    lastModifiedTime: {
        hasCompatibilityError: (airtableCol, databaseCol) => databaseCol.type.js.name !== 'date',
    },

    /*----------------------------------
    - STRINGS
    ----------------------------------*/
    email: {
        hasCompatibilityError: (airtableCol, databaseCol) => databaseCol.type.js.name !== 'string',
    },
    url: {
        hasCompatibilityError: (airtableCol, databaseCol) => databaseCol.type.js.name !== 'string',
    },
    formula: {
        hasCompatibilityError: (airtableCol, databaseCol) => databaseCol.type.js.name !== 'string',
    },
    multilineText: {
        hasCompatibilityError: (airtableCol, databaseCol) => databaseCol.type.js.name !== 'string',
    },
    phoneNumber: {
        hasCompatibilityError: (airtableCol, databaseCol) => databaseCol.type.js.name !== 'string',
    },
    richText: {
        hasCompatibilityError: (airtableCol, databaseCol) => databaseCol.type.js.name !== 'string',
    },
    rollup: {
        hasCompatibilityError: (airtableCol, databaseCol) => databaseCol.type.js.name !== 'string',
    },
    singleLineText: {
        hasCompatibilityError: (airtableCol, databaseCol) => databaseCol.type.js.name !== 'string',
    },

    /*----------------------------------
    - SPECIAL
    ----------------------------------*/

    multipleAttachments: {
        // Should have special treatment
        hasCompatibilityError: (airtableCol, databaseCol) => false,
    },

    /*----------------------------------
    - FOREIGN KEY
    ----------------------------------*/
    // https://airtable.com/developers/web/api/field-model#foreignkey
    // WARN: null when empty
    multipleRecordLinks: {
        toV1: (v2Value: { id: string }[]) => v2Value?.map(v => v.id),
        // Is only used when the column is a toOne
        // When it's a toMany, we don't have a database column to check so this func isn't called
        hasCompatibilityError: (airtableCol, databaseCol) => databaseCol.type.js.name !== 'string',
    },
    multipleLookupValues: {
        hasCompatibilityError: (airtableCol, databaseCol) => 'This field should have been transformated by the destination type in provider.loadMetadatas.'
    },
}

export default typeHelpers;