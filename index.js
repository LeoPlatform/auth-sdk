if ((process.env.LEO_ENVIRONMENT || process.env.NODE_ENV) == null) {
	let env = ((process.env.AWS_LAMBDA_FUNCTION_NAME ?? '').match(/\W((?:dev|test|stage|staging|prod).*?)(?:\W|$)/i) ??
		[])[1];

	if (env != null) {
		process.env.LEO_ENVIRONMENT = env;
	}
}
if (process.env.AWS_REGION == null) {
	process.env.AWS_REGION = "us-east-1";
}



const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocument } = require("@aws-sdk/lib-dynamodb");
const { NodeHttpHandler } = require('@aws-sdk/node-http-handler');
const https = require("https");
const merge = require('lodash.merge');

const chunk = require('./lib/chunker');
var policy = require("./lib/policy");
let dynamodb = getDDBClient();
let { ConfigProviderChain, ProvidersInputType, GenericConfiguration, Provider } = require("./lib/provider-chain")

let globalConfig = new ConfigProviderChain('leoauth', [function() {
	return new GenericConfiguration(() => {
		let config = require("leo-config");

		let values = config.leoauth || config.leo_auth || config["leo-auth"] ||
			config.rstreamsauth || config.rstreams_auth || config["rstreams-auth"];
		if (values == null) {
			throw util.error(
				new Error(`Unable to get config from leo-config env ${config.env}`),
				{ code: 'LeoAuthConfigurationProviderFailure' }
			);
		}

		return values
	});
}], ProvidersInputType.Prepend).resolve();

let USER_TABLE = globalConfig.LeoAuthUser;
let AUTH_TABLE = globalConfig.LeoAuth;


let authConfig = {};

function getDDBClient(configure = {}) {
	let docClient = DynamoDBDocument.from(new DynamoDBClient({
		region: configure.region || (configure.aws && configure.aws.region),
		maxAttempts: 3,
		requestHandler: new NodeHttpHandler({
			connectionTimeout: parseInt(process.env.DYNAMODB_CONNECT_TIMEOUT_MS, 10) || 2000,
			requestTimeout: parseInt(process.env.DYNAMODB_TIMEOUT_MS, 10) || 5000,
			httpsAgent: new https.Agent({
				ciphers: 'ALL',
			})
		}),
		credentials: configure.credentials
	}), {
		marshallOptions: {
			convertEmptyValues: true
		}
	})
	return {
		batchGetHashkey: function(table, hashkey, ids, opts = {}) {
			return this.batchGetTable(table, ids.map((e) => {
				let ret = {};
				ret[hashkey] = e;
				return ret;
			}), opts).then(results => {
				let result = {};
				for (let i = 0; i < results.length; i++) {
					let row = results[i];
					result[row[hashkey]] = row;
				}
				return result;
			});
		},
		batchGetTable: (table, keys, opts = {}) => {
			return new Promise((resolve, reject) => {
				opts = merge({
					chunk_size: 100,
					concurrency: 3
				}, opts);
				let uniquemap = {};
				let results = [];
				let chunker = chunk(function(items, done) {
					if (items.length > 0) {
						let params = {
							RequestItems: {},
							ReturnConsumedCapacity: 'TOTAL',
						};
						params.RequestItems[table] = {
							Keys: items
						};
						docClient.batchGet(params, function(err, data) {
							if (err) {
								logger.error(err);
								done(err, items);
							} else {
								results = results.concat(data.Responses[table]);
								done(null, []);
							}
						});
					} else {
						done(null, []);
					}
				}, opts);

				for (let i = 0; i < keys.length; i++) {
					let identifier = JSON.stringify(keys[i]);
					if (!(identifier in uniquemap)) {
						uniquemap[identifier] = 1;
						chunker.add(keys[i]);
					}
				}

				chunker.end((err, rs) => {
					if (err) {
						reject(err);
					} else {
						resolve(results);
					}
				});
			});
		},
		get: (table, id, opts = {}) => {
			let key = id;
			if (typeof key !== 'object') {
				key = {
					[opts.id || 'id']: key,
				};
			}
			return docClient.get({
				ConsistentRead: true,
				Key: key,
				ReturnConsumedCapacity: 'TOTAL',
				TableName: table,
			}).then(data => {
				if (!data.Item) {
					return opts.default || null;
				} else {
					return data.Item;
				}
			});
		},
	}
}
function wrapUser(user) {
	user.authorize = async function(event, resource) {
		var request = createRequest(event, resource);
		user.cognitoId = request.cognito.id;
		let statements = [];
		if (authConfig.statements) {
			user.identities.concat('*').map(id => {
				statements = statements.concat(authConfig.statements[id]);
			});
		} else {
			let data = await dynamodb.batchGetHashkey(AUTH_TABLE, "identity", user.identities.concat('*'), {});
			if (!resource.context) {
				resource.context = [];
			}
			if (!Array.isArray(resource.context)) {
				resource.context = [resource.context];
			}
			for (var id in data) {
				for (var name in data[id].policies) {
					statements = statements.concat(data[id].policies[name]);
				}
				resource.context.map(c => {
					user.context[c] = Object.assign(user.context[c] || {}, data[id][c])
				});
			}
		}
		var result = policy.validate(request, policy.contextify(user.context, statements));
		if (result.auth !== true) {
			throw "Access Denied";
		}
		return user;
	};
	return user;
}

function createRequest(event, resource) {
	var lrn = resource.lrn;

	if (authConfig.resourcePrefix && !lrn.match(/^lrn/)) {
		lrn = authConfig.resourcePrefix + lrn;
	}

	var matches = lrn.match(/lrn:([^:]*):([^:]*)/);
	var system = matches[2];
	var params = resource[system];

	for (var key in params) {
		var val = params[key];
		if (val && val.replace) {
			val = val.replace(/:/g, '');
			lrn = lrn.replace(new RegExp("{" + key + "}", 'g'), val);
		}
	}
	var request = {
		id: event.requestContext.requestId,
		time: Date.now(),
		action: system + ":" + resource.action,
		lrn: lrn,
		aws: Object.assign({}, event.requestContext.identity, event.requestContext),
		cognito: {
			id: event.requestContext.identity.cognitoIdentityId,
			provider: event.requestContext.identity.cognitoAuthenticationProvider,
			type: event.requestContext.identity.cognitoAuthenticationType,
			poolId: event.requestContext.identity.cognitoIdentityPoolId
		}
	};
	request[system] = resource[system];
	return request;
};


const typeConverters = {
	number: (value) => parseFloat(value),
	int: (value) => parseInt(value, 10),
	boolean: (value) => value === 'true' || value === '1',
}

function getPassedContext(event, body) {
	body = body || event.body || {};
	if (typeof body === 'string') {
		try {
			body = JSON.parse(body) || {};
		} catch (e) {
			body = {};
		}
	}
	const context = Object.entries(event.queryStringParameters || {}).reduce(
		(ctx, [key, value]) => {
			let k;
			if ((k = key.match(/^ctx[_-](.*)$/))) {

				// Check for any type conversions on the query parameter
				let type = event.queryStringParameters["t_" + key];
				let converter = typeConverters[type];
				if (converter) {
					value = converter(value);					
				}
				ctx[k[1]] = value;
			}
			return ctx;
		},
		body._context || {}
	);

	// Multi value query parameters support (arrays) this is the default for HTTP requests to the API Gateway
	if(event.multiValueQueryStringParameters) { 
		Object.entries(event.multiValueQueryStringParameters).forEach(([key, values]) => {
			let k;
			if ((k = key.match(/^ctx[_-](.*)$/))) {

				let type = event.multiValueQueryStringParameters["t_" + key];
				let converter = typeConverters[type];
				if (converter) {
					values = values.map(v => converter(v));
				}
				context[k[1]] = values;
			}
		});
	}
	//delete body._context;
	return context;
}

module.exports = {
	typeConverters,
	getPassedContext,
	configuration: {
		LeoAuth: AUTH_TABLE,
		LeoAuthUser: USER_TABLE
	},
	getUser: async function(id) {
		let origId = id;
		if (id && id.requestContext) {
			id = id.requestContext;
		}
		let passedContext = {};

		// Admin caller. Check for proxy cognitoIdentityId
		if (id && id.identity && !id.identity.cognitoIdentityId && id.identity.caller) {
			passedContext = getPassedContext(origId);
			if (passedContext.cognitoIdentityId) {
				id.identity.cognitoIdentityId = passedContext.cognitoIdentityId;
				//delete id.identity.caller;
				//delete passedContext.cognitoIdentityId
			}
		}

		if (!id) {
			return wrapUser({
				context: {},
				identity_id: id,
				identities: []
			});
		} else if (id && id.identity && !id.identity.cognitoIdentityId && id.identity.caller) {
			return wrapUser({
				identity_id: "aws_key",
				context: Object.assign(passedContext, {
					key: id.identity.caller
				}),
				//prepend possible other passed in identities
				identities: (Array.isArray(passedContext.identities) ? passedContext.identities.concat(["role/aws_key"]) : ["role/aws_key"])
			});
		} else {
			if (id && id.identity) {
				id = id.identity.cognitoIdentityId || '*';
			}

			return dynamodb.get(USER_TABLE, id, {
				id: "identity_id"
			}).then(data => {
				if (!data || data.identity_id !== id) {
					return wrapUser({
						context: {},
						identity_id: id,
						identities: []
					});
				} else {
					//Support older ones where it was stored as a string
					if (typeof data.context == "string") {
						data.context = JSON.parse(data.context);
					}
					return wrapUser(data);
				}
			});
		}
	},
	authorize: async function(event, resource, user = null) {
		if (user) {
			if (!("authorize" in user)) {
				wrapUser(user);
			}
			return user.authorize(event, resource);
		} else {
			return module.exports.getUser(event).then(user => user.authorize(event, resource));
		}
	},
	bootstrap: function(config) {
		if (config.actions) {
			let actionPrefix = config.actions;
			if (!actionPrefix) {
				throw new Error("You have not defined an action prefix");
			}
			let resourcePrefix = config.resource;
			let parts = resourcePrefix.split(/:/).filter(e => e.length != 0);
			if (!resourcePrefix || parts.length < 3) {
				throw new Error("You have not defined an action prefix");
			};
			while (parts.length <= 5) {
				parts.push('');
			}
			resourcePrefix = parts.join(":");
			let statements = {};
			Object.keys(config.identities).map(id => {
				let p = config.identities[id];
				statements[id] = [];
				p.map(policy => {
					//stringify it so it matches the old way of doing it for now
					statements[id] = statements[id].concat(config.policies[policy].map(p => {
						if (p.Action && !p.Action.match(/:/)) {
							p.Action = actionPrefix + ":" + p.Action;
						}
						if (p.Resource && !p.Resource.match(/^lrn/)) {
							p.Resource = resourcePrefix + p.Resource;
						}
						return JSON.stringify(p);
					}));
				});
			});
			authConfig = {
				actionPrefix: actionPrefix,
				resourcePrefix: resourcePrefix,
				statements: statements
			}
		}
	}
};
