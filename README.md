# Leo Auth SDK

A flexible, policy-based authorization system inspired by AWS IAM, designed for the Leo Platform. This SDK provides a robust way to control access to resources using identity-based policies with support for conditions, wildcards, and context variables.

## Table of Contents

- [Overview](#overview)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [Core Concepts](#core-concepts)
- [Usage Examples](#usage-examples)
- [Creating Auth Rules](#creating-auth-rules)
- [Policy Structure](#policy-structure)
- [Conditions](#conditions)
- [Context Variables](#context-variables)
- [Bootstrap Mode](#bootstrap-mode)
- [API Reference](#api-reference)

## Overview

The Leo Auth SDK provides a policy-based authorization system that allows you to:

- Define granular access controls for resources
- Support multiple identities and roles per user
- Use wildcards and pattern matching for flexible policies
- Apply conditional logic based on IP addresses, context variables, and more
- Store policies in DynamoDB or define them in code

## How It Works

### Plain English Explanation

The Leo Auth system works like a security guard that checks if a user can do something with a resource:

1. **User Lookup**: When a request comes in, the system first looks up the user by their Cognito Identity ID from the `LeoAuthUser` DynamoDB table. Users have:
   - An identity ID (like a username)
   - A list of roles/identities they belong to (like "admin", "user", "role/aws_key")
   - Context information (like account IDs, custom metadata)

2. **Policy Retrieval**: The system then fetches all policies associated with the user's identities from the `LeoAuth` DynamoDB table. Policies can also be pulled from a wildcard (`*`) identity that applies to everyone.

3. **Request Building**: The request is structured with:
   - An **action** (what they want to do, like "user:read" or "queue:write")
   - A **LRN** (Leo Resource Name, similar to AWS ARN, like "lrn:leo:system:::resource")
   - Context information (IP address, cognito details, custom fields)

4. **Policy Evaluation**: The system evaluates policies in two phases:
   - **Deny Phase**: First, check if any policy explicitly denies the action. If so, reject immediately (deny always wins)
   - **Allow Phase**: Then, check if any policy allows the action. If at least one allows it, grant access
   
5. **Condition Checking**: Within each policy, conditions can be specified (like IP address ranges, string matching, null checks). All conditions must pass for the policy to apply.

6. **Decision**: If no explicit deny and at least one allow, access is granted. Otherwise, access is denied.

### Technical Flow

```
User Request → getUser() → User Object with Identities
                              ↓
                          authorize()
                              ↓
              Fetch Policies for all user identities (+ "*")
                              ↓
                      Create Request Object
                      (action, LRN, context)
                              ↓
                      Policy Validation
                              ↓
                ┌─────────────┴─────────────┐
                ↓                           ↓
           Check DENY policies      Check ALLOW policies
                ↓                           ↓
         Any deny matches?          Any allow matches?
                ↓                           ↓
            DENIED ←─────YES         YES─→ GRANTED
                                            ↓
                                        NO → DENIED
```

## Configuration

The SDK automatically discovers configuration from multiple sources (checked in order):

1. **Environment Variables**: `LEOAUTH`, `LEOAUTH_*` (uppercase/lowercase with underscores)
2. **Process/Global Objects**: `process.leoauth`, `global.leoauth`
3. **Config Files**: Looking up the directory tree for:
   - `leoauth.config.json`, `leoauth.config.js`
   - `leoauthconfig.json`, `leoauthconfig.js`
   - `config/leoauth.config.json`, etc.
4. **AWS Secrets Manager**: `LEOAUTH_CONFIG_SECRET` environment variable
5. **leo-config package**: Falls back to `config.leoauth`, `config.leo_auth`, etc.

### Required Configuration

```javascript
{
  "LeoAuth": "YourAuthPoliciesTableName",      // DynamoDB table with policies
  "LeoAuthUser": "YourAuthUsersTableName"      // DynamoDB table with users
}
```

### Configuration via Environment Variables

```bash
# Option 1: JSON string
export LEOAUTH='{"LeoAuth":"auth-table","LeoAuthUser":"users-table"}'

# Option 2: Individual variables
export LEOAUTH_LeoAuth="auth-table"
export LEOAUTH_LeoAuthUser="users-table"
```

## Core Concepts

### 1. **Identities**
An identity is a role or group that a user belongs to. Users can have multiple identities:
- `"admin"`
- `"role/readonly"`
- `"team/engineering"`
- `"*"` (everyone)

### 2. **LRN (Leo Resource Name)**
A hierarchical resource identifier, similar to AWS ARNs:

Format: `lrn:service:system:region:account:resource`

Example: `lrn:leo:rstreams:::queue/my-queue`

### 3. **Actions**
What operation is being performed, typically in `system:action` format:
- `rstreams:read`
- `rstreams:write`
- `user:update`
- `queue:delete`

### 4. **Policies**
Rules that define what actions are allowed or denied on which resources, optionally with conditions.

## Usage Examples

### Basic Authorization

```javascript
const leoAuth = require('leo-auth');

// In your Lambda function or API handler
async function handler(event) {
  try {
    // Get the user from the request
    const user = await leoAuth.getUser(event);
    
    // Authorize the user for a specific action
    await user.authorize(event, {
      lrn: 'lrn:leo:rstreams:::queue/my-queue',
      action: 'read',
      rstreams: {
        queue: 'my-queue'
      }
    });
    
    // If we get here, user is authorized
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Access granted' })
    };
    
  } catch (error) {
    // Authorization failed
    return {
      statusCode: 403,
      body: JSON.stringify({ message: 'Access Denied' })
    };
  }
}
```

### Authorization with Resource Variables

```javascript
// Authorize access to a specific queue by ID
const queueId = 'user-notifications';

await user.authorize(event, {
  lrn: 'lrn:leo:rstreams:::queue/{queueId}',
  action: 'write',
  rstreams: {
    queueId: queueId  // This replaces {queueId} in the LRN
  }
});
```

### One-Step Authorization

```javascript
// Combines getUser and authorize in one call
const user = await leoAuth.authorize(event, {
  lrn: 'lrn:leo:api:::user/{userId}',
  action: 'update',
  api: {
    userId: '12345'
  }
});
```

### Using Context in Authorization

```javascript
// Pass context that can be checked in policy conditions
await user.authorize(event, {
  lrn: 'lrn:leo:data:::account/{accountId}/records',
  action: 'read',
  data: {
    accountId: '999'
  },
  context: ['account']  // Makes user's account context available to policies
});
```

### Admin User Proxying

```javascript
// Admin can act on behalf of another user by passing cognitoIdentityId in context
const event = {
  body: JSON.stringify({
    _context: {
      cognitoIdentityId: 'user-to-impersonate'
    },
    // ... other data
  }),
  requestContext: {
    identity: {
      caller: 'admin-aws-key'  // Admin using AWS key
    }
  }
};

const user = await leoAuth.getUser(event);
// User will be loaded as 'user-to-impersonate' instead of admin
```

## Creating Auth Rules

Auth rules are created by adding entries to the DynamoDB tables. Here's how to set up the authorization data:

### 1. DynamoDB Table Structure

#### LeoAuthUser Table (Users)

```javascript
{
  "identity_id": "us-east-1:12345678-1234-1234-1234-123456789abc",  // Primary Key
  "identities": [
    "role/developer",
    "team/backend"
  ],
  "context": {
    "account": "999",
    "department": "engineering"
  }
}
```

#### LeoAuth Table (Policies)

```javascript
{
  "identity": "role/developer",  // Primary Key
  "policies": {
    "AllowReadQueues": [
      "{\"Effect\":\"Allow\",\"Action\":\"rstreams:read\",\"Resource\":\"lrn:leo:rstreams:::queue/*\"}"
    ],
    "AllowWriteOwnQueue": [
      "{\"Effect\":\"Allow\",\"Action\":\"rstreams:write\",\"Resource\":\"lrn:leo:rstreams:::queue/${context.account}/*\",\"Condition\":{\"StringEquals\":{\"context:account\":\"${context.account}\"}}}"
    ]
  }
}
```

### 2. Creating Policies Programmatically

```javascript
// Example: Add a new user with policies
const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();

// Create a user
await dynamodb.put({
  TableName: 'YourAuthUsersTable',
  Item: {
    identity_id: 'us-east-1:user-cognito-id',
    identities: ['role/analyst', 'team/data'],
    context: {
      account: '12345',
      region: 'us-west-2'
    }
  }
}).promise();

// Create policies for the role
await dynamodb.put({
  TableName: 'YourAuthPoliciesTable',
  Item: {
    identity: 'role/analyst',
    policies: {
      ReadData: [
        JSON.stringify({
          Effect: 'Allow',
          Action: 'data:read',
          Resource: 'lrn:leo:data:::*'
        })
      ],
      NoDelete: [
        JSON.stringify({
          Effect: 'Deny',
          Action: 'data:delete',
          Resource: '*'
        })
      ]
    }
  }
}).promise();

// Create a wildcard policy that applies to everyone
await dynamodb.put({
  TableName: 'YourAuthPoliciesTable',
  Item: {
    identity: '*',
    policies: {
      BasicAccess: [
        JSON.stringify({
          Effect: 'Allow',
          Action: 'system:health',
          Resource: 'lrn:leo:system:::health'
        })
      ]
    }
  }
}).promise();
```

### 3. Example Policy Scenarios

#### Allow all actions on a specific resource

```json
{
  "Effect": "Allow",
  "Action": "*",
  "Resource": "lrn:leo:rstreams:::queue/my-queue"
}
```

#### Allow specific actions with wildcards

```json
{
  "Effect": "Allow",
  "Action": "rstreams:*",
  "Resource": "lrn:leo:rstreams:::queue/*"
}
```

#### Deny with IP restriction

```json
{
  "Effect": "Deny",
  "Action": "*",
  "Resource": "*",
  "Condition": {
    "IpAddress": {
      "aws:sourceip": ["10.0.0.0/8"]
    }
  }
}
```

#### Allow with context variable matching

```json
{
  "Effect": "Allow",
  "Action": "data:read",
  "Resource": "lrn:leo:data:::account/${context.account}/*",
  "Condition": {
    "StringEquals": {
      "context:account": "${context.account}"
    }
  }
}
```

## Policy Structure

Policies are JSON objects with the following fields:

```javascript
{
  "Effect": "Allow" | "Deny",           // Required: Allow or Deny
  "Action": "action:pattern",            // Required: Action to match (supports wildcards)
  "Resource": "lrn:pattern",             // Required: Resource LRN (supports wildcards)
  "Condition": {                         // Optional: Conditions that must be met
    "ConditionType": {
      "field:name": ["value1", "value2"]
    }
  }
}
```

### Alternative Fields

- `"NotAction"`: Match all actions EXCEPT these
- `"NotResource"`: Match all resources EXCEPT these

### Examples

```javascript
// Simple allow
{
  "Effect": "Allow",
  "Action": "queue:read",
  "Resource": "lrn:leo:rstreams:::queue/public-*"
}

// Deny everything except specific action
{
  "Effect": "Deny",
  "NotAction": "queue:read",
  "Resource": "*"
}

// Allow everything except sensitive resources
{
  "Effect": "Allow",
  "Action": "*",
  "NotResource": "lrn:leo:rstreams:::queue/sensitive-*"
}
```

## Conditions

Conditions allow you to add fine-grained control based on request attributes.

### Available Condition Types

#### String Conditions

- **`StringEquals`**: Exact string match
- **`StringNotEquals`**: String does not match
- **`StringLike`**: Pattern match with wildcards (`*` for any characters)
- **`StringNotLike`**: Does not match pattern

```javascript
{
  "Condition": {
    "StringEquals": {
      "context:department": "engineering"
    }
  }
}

{
  "Condition": {
    "StringLike": {
      "context:email": "*@company.com"
    }
  }
}
```

#### Null Condition

- **`Null`**: Check if field exists (true) or has a value (false)

```javascript
{
  "Condition": {
    "Null": {
      "context:account": false  // Account must exist and have a value
    }
  }
}
```

#### IP Address Condition

- **`IpAddress`**: Check if IP is within CIDR range(s)

```javascript
{
  "Condition": {
    "IpAddress": {
      "aws:sourceip": ["192.168.1.0/24", "10.0.0.0/8"]
    }
  }
}
```

#### Array Conditions

All condition types can be prefixed with `ForAllValues:` or `ForAnyValue:` to work with arrays:

- **`ForAllValues:`**: All values in the array must match
- **`ForAnyValue:`**: At least one value in the array must match

```javascript
{
  "Condition": {
    "ForAllValues:StringLike": {
      "context:roles": "team/*"  // All roles must start with "team/"
    }
  }
}

{
  "Condition": {
    "ForAnyValue:StringEquals": {
      "context:permissions": "admin"  // At least one permission is "admin"
    }
  }
}
```

### Accessing Request Fields in Conditions

The system flattens the request object with `:` separators. For example:

```javascript
// Request object:
{
  action: "data:read",
  lrn: "lrn:leo:data:::records",
  context: {
    account: "123",
    nested: {
      value: "test"
    }
  },
  aws: {
    sourceIp: "192.168.1.1"
  }
}

// Becomes flattened as:
{
  "action": "data:read",
  "lrn": "lrn:leo:data:::records",
  "context:account": "123",
  "context:nested:value": "test",
  "aws:sourceip": "192.168.1.1"
}
```

## Context Variables

Context variables allow policies to be dynamic based on user attributes.

### Defining Context Variables

Context is stored with the user and can be referenced in policies using `${variable.name}` syntax:

```javascript
// User object
{
  identity_id: "user-123",
  identities: ["role/user"],
  context: {
    account: "999",
    department: "sales",
    regions: ["us-east-1", "us-west-2"]
  }
}

// Policy using context variables
{
  "Effect": "Allow",
  "Action": "data:read",
  "Resource": "lrn:leo:data:::account/${context.account}/*"
}

// At runtime, this becomes:
{
  "Effect": "Allow",
  "Action": "data:read",
  "Resource": "lrn:leo:data:::account/999/*"
}
```

### Variable Substitution

- **String values**: `${context.account}` → `"999"`
- **Array values**: `${context.regions}` → `"us-east-1,us-west-2"`
- **Function values**: Can define functions in context that are called during substitution

### Example with Quoted Variables

```javascript
// Policy
{
  "Condition": {
    "StringEquals": {
      "request:account": "${context.account}"
    }
  }
}

// If context.account is an array ["123", "456"], becomes:
{
  "Condition": {
    "StringEquals": {
      "request:account": ["123", "456"]
    }
  }
}
```

## Bootstrap Mode

For testing or applications where you want to define policies in code instead of DynamoDB, use bootstrap mode:

```javascript
const leoAuth = require('leo-auth');

leoAuth.bootstrap({
  actions: 'myapp',              // Action prefix
  resource: 'lrn:leo:myapp:',   // Resource prefix (auto-completed to 6 parts)
  
  // Define which identities get which policies
  identities: {
    '*': ['PublicAccess'],
    'role/admin': ['PublicAccess', 'AdminAccess'],
    'role/user': ['PublicAccess', 'UserAccess']
  },
  
  // Define the actual policies
  policies: {
    PublicAccess: [{
      Effect: 'Allow',
      Action: 'health',              // Will become 'myapp:health'
      Resource: 'system/health'      // Will become 'lrn:leo:myapp:::system/health'
    }],
    
    AdminAccess: [{
      Effect: 'Allow',
      Action: '*',
      Resource: '*'
    }],
    
    UserAccess: [{
      Effect: 'Allow',
      Action: 'read',
      Resource: 'data/public/*'
    }, {
      Effect: 'Deny',
      Action: 'delete',
      Resource: '*'
    }]
  }
});

// Now when you call authorize, it will use these in-memory policies
// instead of querying DynamoDB
```

### Bootstrap Prefix Rules

- **Actions without `:` prefix**: Automatically prefixed with the `actions` value
  - `"read"` → `"myapp:read"`
  - `"something:write"` → `"something:write"` (already has colon, not prefixed)

- **Resources without `lrn` prefix**: Automatically prefixed with the `resource` value
  - `"data/records"` → `"lrn:leo:myapp:::data/records"`
  - `"lrn:other:thing"` → `"lrn:other:thing"` (already starts with lrn, not prefixed)

## API Reference

### getUser(event)

Retrieves a user object from the authentication system.

**Parameters:**
- `event` (Object|String): Lambda event object with `requestContext.identity.cognitoIdentityId`, or a cognito ID string

**Returns:** `Promise<User>` - User object with `authorize()` method

**Example:**
```javascript
const user = await leoAuth.getUser(event);
console.log(user.identity_id);
console.log(user.identities);
console.log(user.context);
```

### authorize(event, resource, user = null)

Authorizes a user for a specific action on a resource.

**Parameters:**
- `event` (Object): Lambda event object with request context
- `resource` (Object): Resource definition with:
  - `lrn` (String): Leo Resource Name
  - `action` (String): Action to perform
  - `context` (Array|String): Optional context fields to include
  - `[system]` (Object): System-specific parameters for LRN variable substitution
- `user` (Object): Optional pre-fetched user object

**Returns:** `Promise<User>` - Authorized user object

**Throws:** `"Access Denied"` if authorization fails

**Example:**
```javascript
await leoAuth.authorize(event, {
  lrn: 'lrn:leo:rstreams:::queue/{queueId}',
  action: 'write',
  rstreams: {
    queueId: 'my-queue'
  }
});
```

### bootstrap(config)

Configure authorization policies in code rather than DynamoDB.

**Parameters:**
- `config` (Object):
  - `actions` (String): Action prefix for unprefixed actions
  - `resource` (String): Resource LRN prefix for unprefixed resources
  - `identities` (Object): Map of identity names to policy arrays
  - `policies` (Object): Map of policy names to policy statement arrays

**Returns:** `void`

**Example:**
```javascript
leoAuth.bootstrap({
  actions: 'api',
  resource: 'lrn:leo:api:',
  identities: {
    '*': ['PublicPolicy'],
    'role/admin': ['PublicPolicy', 'AdminPolicy']
  },
  policies: {
    PublicPolicy: [{
      Effect: 'Allow',
      Action: 'health',
      Resource: 'health'
    }],
    AdminPolicy: [{
      Effect: 'Allow',
      Action: '*',
      Resource: '*'
    }]
  }
});
```

### configuration

Access to the resolved configuration.

**Example:**
```javascript
const leoAuth = require('leo-auth');
console.log(leoAuth.configuration.LeoAuth);     // Policy table name
console.log(leoAuth.configuration.LeoAuthUser); // User table name
```

## Testing Your Policies

Here's a simple test pattern:

```javascript
const leoAuth = require('leo-auth');

// Use bootstrap for testing
leoAuth.bootstrap({
  actions: 'test',
  resource: 'lrn:leo:test:',
  identities: {
    'role/test': ['TestPolicy']
  },
  policies: {
    TestPolicy: [{
      Effect: 'Allow',
      Action: 'read',
      Resource: '*'
    }]
  }
});

async function testAuthorization() {
  const mockEvent = {
    requestContext: {
      requestId: 'test-123',
      identity: {
        cognitoIdentityId: 'test-user'
      }
    }
  };

  // Create a mock user
  const user = {
    identity_id: 'test-user',
    identities: ['role/test'],
    context: {}
  };

  try {
    await leoAuth.authorize(mockEvent, {
      lrn: 'lrn:leo:test:::resource',
      action: 'read',
      test: {}
    }, user);
    console.log('✓ Authorization passed');
  } catch (error) {
    console.log('✗ Authorization failed:', error);
  }
}

testAuthorization();
```

## Best Practices

1. **Use Deny Sparingly**: Deny always overrides Allow, so use it only for explicit restrictions

2. **Principle of Least Privilege**: Start with minimal permissions and add more as needed

3. **Use Wildcards Carefully**: `*` in resources can grant broad access; prefer specific patterns

4. **Leverage Context Variables**: Store account IDs, regions, etc. in user context for dynamic policies

5. **Test Conditions Thoroughly**: Conditions can be complex; test edge cases

6. **Use Bootstrap for Development**: Define policies in code during development, DynamoDB for production

7. **Document Your Identities**: Maintain clear documentation of what each role/identity can do

8. **Version Your Policies**: When updating policies in DynamoDB, consider keeping old versions for rollback

## Troubleshooting

### "Access Denied" errors

1. Check if user's identities are correct
2. Verify policies exist for those identities (and `*`)
3. Review Deny policies first (they override Allow)
4. Check if conditions are failing
5. Verify LRN and action patterns match

### Condition not working

1. Flatten your request object mentally and check field names use `:` separator
2. Remember all fields are lowercase in conditions
3. Verify the condition type supports your data type

### Context variables not substituting

1. Ensure context is defined on the user object
2. Check variable syntax: `${context.field}` not `$context.field`
3. If variable doesn't exist, an error is thrown

### Bootstrap policies not applying

1. Call `bootstrap()` before any authorization calls
2. Bootstrap overrides DynamoDB; you can't mix both in one request

## License

MIT

## Contributing

Issues and pull requests welcome at [LeoPlatform/auth-sdk](https://github.com/LeoPlatform/auth-sdk)

