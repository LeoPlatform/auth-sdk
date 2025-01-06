
import sinon from "sinon";
import chai, { expect, assert } from "chai";
import sinonchai from "sinon-chai";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";
chai.use(sinonchai);

const AwsMocks = [];

let mockSdkConfig = {
	LeoAuth: "mock-LeoAuth",
	LeoAuthUser: "mock-LeoAuthUser"
};
(process as any).leoauth = mockSdkConfig;
import { getUser, authorize } from "../index";

let envVars = ["LEOAUTH", "LEOAUTH_CONFIG_SECRET"];
let keys = Object.keys(mockSdkConfig);

describe('index', function () {
	let sandbox: sinon.SinonSandbox;
	beforeEach(() => {
		(process as any).leoauth = mockSdkConfig;

		sandbox = sinon.createSandbox();
		AwsMocks.forEach(m => m.reset());
		delete require.cache[require.resolve("..")];
	});
	afterEach(() => {
		sandbox.restore();
		AwsMocks.forEach(m => m.restore());
		envVars.forEach(field => {
			delete process.env[field];
			delete process[field];
			delete global[field];
			keys.forEach(key => {
				delete process.env[`${field}_${key}`];
			});
		});

		delete process.env.LEO_ENVIRONMENT;
		delete require("leo-config").leoauth;
		delete require("leo-config").leoaws;
		delete global.leoauth;
		delete (process as any).__config;
	});
	after(() => {
		delete require[require.resolve("leo-config")];
	});

	describe('sdk', function () {

		it("creates an sdk", () => {
			let sdk = require("..");

			assert.deepEqual(sdk.configuration, {
				LeoAuth: "mock-LeoAuth",
				LeoAuthUser: "mock-LeoAuthUser"
			});
		});

		describe("get user", () => {
			it("gets user - default", async () => {

				let get = sandbox.stub()
					.onFirstCall().returns(Promise.resolve({
						Item: {}
					}));
				sandbox.stub(DynamoDBDocument, 'from').returns({ get } as unknown as DynamoDBDocument);

				let sdk = require("..");
				let user = await sdk.getUser({
					requestContext: {
						identity: "identity-1234"
					}
				});

				assert.deepEqual(user.context, {});
				assert.deepEqual(user.identities, []);
				assert.deepEqual(user.identity_id, "*");
			});

			it("gets user - empty", async () => {

				let get = sandbox.stub()
					.onFirstCall().returns(Promise.resolve({
						Item: {}
					}));
				sandbox.stub(DynamoDBDocument, 'from').returns({ get } as unknown as DynamoDBDocument);

				let sdk = require("..");
				let user = await sdk.getUser();

				assert.deepEqual(user.context, {});
				assert.deepEqual(user.identities, []);
				assert.deepEqual(user.identity_id, undefined);
			});

			it("gets user - context", async () => {

				let get = sandbox.stub()
					.onFirstCall().returns(Promise.resolve({
						Item: {
							identity_id: "identity-1234",
							identities: ["awesome"],
							context: JSON.stringify({
								value: 234
							})
						}
					}));
				sandbox.stub(DynamoDBDocument, 'from').returns({ get } as unknown as DynamoDBDocument);

				let sdk = require("..");
				let user = await sdk.getUser({
					requestContext: {
						identity: {
							cognitoIdentityId: "identity-1234"
						}
					}
				});

				assert.deepEqual(user.context, { value: 234 });
				assert.deepEqual(user.identities, ["awesome"]);
				assert.deepEqual(user.identity_id, "identity-1234");
			});

			it("gets user - caller", async () => {

				let get = sandbox.stub()
					.onFirstCall().returns(Promise.resolve({
						Item: {
							identity_id: "identity-1234",
							identities: ["awesome"],
							context: JSON.stringify({
								value: 234
							})
						}
					}));
				sandbox.stub(DynamoDBDocument, 'from').returns({ get } as unknown as DynamoDBDocument);

				let sdk = require("..");
				let user = await sdk.getUser({
					requestContext: {
						identity: {
							caller: "identity-1234"
						}
					}
				});

				assert.deepEqual(user.context, { key: "identity-1234" });
				assert.deepEqual(user.identities, ["role/aws_key"]);
				assert.deepEqual(user.identity_id, "aws_key");
			});

			it("gets user - caller w/ context", async () => {

				let get = sandbox.stub()
					.onFirstCall().returns(Promise.resolve({
						Item: {
							identity_id: "identity-1234",
							identities: ["awesome"],
							context: JSON.stringify({
								value: 234
							})
						}
					}));
				sandbox.stub(DynamoDBDocument, 'from').returns({ get } as unknown as DynamoDBDocument);

				let sdk = require("..");
				let user = await sdk.getUser({
					body: JSON.stringify({
						_context: {
							body_data: "abc",
							account: "999999"
						}
					}),
					queryStringParameters: {
						ctx_account: "98765",
						"ctx-value": 3453
					},
					requestContext: {
						identity: {
							caller: "identity-1234"
						}
					}
				});

				assert.deepEqual(user.context, { key: "identity-1234", account: "98765", body_data: "abc", value: 3453 });
				assert.deepEqual(user.identities, ["role/aws_key"]);
				assert.deepEqual(user.identity_id, "aws_key");
			});

			it("gets user - caller w/ context & cognito", async () => {

				let get = sandbox.stub()
					.onFirstCall().returns(Promise.resolve({
						Item: {
							identity_id: "cognitoId-1234",
							identities: ["awesome-again"],
							context: JSON.stringify({
								value: 987
							})
						}
					}));
				sandbox.stub(DynamoDBDocument, 'from').returns({ get } as unknown as DynamoDBDocument);

				let sdk = require("..");
				let user = await sdk.getUser({
					body: JSON.stringify({
						_context: {
							body_data: "abc",
							account: "999999",
							cognitoIdentityId: "cognitoId-1234"
						}
					}),
					queryStringParameters: {
						ctx_account: "98765",
						"ctx-value": 3453
					},
					requestContext: {
						identity: {
							caller: "identity-1234"
						}
					}
				});

				assert.deepEqual(user.context, { value: 987 });
				assert.deepEqual(user.identities, ["awesome-again"]);
				assert.deepEqual(user.identity_id, "cognitoId-1234");
			});
		});

		describe("auth user", () => {
			it("default", async () => {
				let get = sandbox.stub()
					.onFirstCall().returns(Promise.resolve({
						Item: {}
					}));
				let batchGet = sandbox.stub()
					.onFirstCall().callsArgWith(1, null, {
						Responses: {
							"mock-LeoAuth": [{
								policies: {
									"*": [{
										Effect: "Allow",
										Action: "*",
										Resource: "lrn:stuff:*"
									}].map(a => JSON.stringify(a))
								}
							}]
						}
					});

				sandbox.stub(DynamoDBDocument, 'from').returns({ get, batchGet } as unknown as DynamoDBDocument);

				let sdk = require("..");
				let user = await sdk.authorize({
					requestContext: {
						identity: "identity-1234"
					}
				}, {
					lrn: "lrn:stuff:other:::ok",
					action: "doStuff"
				});

				assert.deepEqual(user.context, {});
				assert.deepEqual(user.identities, []);
				assert.deepEqual(user.identity_id, "*");
			});
			it("denied", async () => {
				let get = sandbox.stub()
					.onFirstCall().returns(Promise.resolve({
						Item: {}
					}));
				let batchGet = sandbox.stub()
					.onFirstCall().callsArgWith(1, null, {
						Responses: {
							"mock-LeoAuth": [{
								policies: {
									"*": [{
										Effect: "Deny",
										Action: "*",
										Resource: "lrn:stuff:*"
									}].map(a => JSON.stringify(a))
								}
							}]
						}
					});

				sandbox.stub(DynamoDBDocument, 'from').returns({ get, batchGet } as unknown as DynamoDBDocument);

				let sdk = require("..");
				let error;
				try {
					await sdk.authorize({
						requestContext: {
							identity: "identity-1234"
						}
					}, {
						lrn: "lrn:stuff:other:::ok",
						action: "doStuff"
					});
				} catch (err) {
					error = err;
				}

				if (!error) {
					assert.fail("Should be denied")
				} else {
					assert.equal(error, "Access Denied")
				}
			});
			it("basic user", async () => {

				let batchGet = sandbox.stub()
					.onFirstCall().callsArgWith(1, null, {
						Responses: {
							"mock-LeoAuth": [{
								policies: {
									"*": [{
										Effect: "Deny",
										Action: "*",
										Resource: "lrn:stuff:*"
									}].map(a => JSON.stringify(a))
								}
							}]
						}
					});

				sandbox.stub(DynamoDBDocument, 'from').returns({ batchGet } as unknown as DynamoDBDocument);

				let sdk = require("..");
				let error;
				try {
					await sdk.authorize({
						requestContext: {
							identity: "identity-1234"
						}
					}, {
						lrn: "lrn:stuff:other:::ok",
						action: "doStuff"
					}, {
						identity_id: "",
						context: {},
						identities: []
					});
				} catch (err) {
					error = err;
				}

				if (!error) {
					assert.fail("Should be denied")
				} else {
					assert.equal(error, "Access Denied")
				}
			});
		})

		describe("bootstrap", () => {
			it("bootstraps - default", async () => {

				let get = sandbox.stub()
					.onFirstCall().returns(Promise.resolve({
						Item: {}
					}));
				let batchGet = sandbox.stub()
					.onFirstCall().callsArgWith(1, null, {
						Responses: {
							"mock-LeoAuth": [{
								policies: {
									"*": [{
										Effect: "Allow",
										Action: "*",
										Resource: "lrn:stuff:*"
									}].map(a => JSON.stringify(a))
								}
							}]
						}
					});

				sandbox.stub(DynamoDBDocument, 'from').returns({ get, batchGet } as unknown as DynamoDBDocument);


				let sdk = require("..");
				sdk.bootstrap({});
				let user = await sdk.authorize({
					requestContext: {
						identity: "identity-1234"
					}
				}, {
					lrn: "lrn:stuff:other:::ok",
					action: "doStuff"
				});

				assert.deepEqual(user.context, {});
				assert.deepEqual(user.identities, []);
				assert.deepEqual(user.identity_id, "*");

			})

			it("bootstraps - prefix", async () => {

				let get = sandbox.stub()
					.onFirstCall().returns(Promise.resolve({
						Item: {}
					}));
				let batchGet = sandbox.stub()
					.onFirstCall().callsArgWith(1, null, {
						Responses: {
							"mock-LeoAuth": [{
								policies: {}
							}]
						}
					});

				sandbox.stub(DynamoDBDocument, 'from').returns({ get, batchGet } as unknown as DynamoDBDocument);


				let sdk = require("..");
				sdk.bootstrap({
					actions: "action-prefix",
					resource: "resource-prefix:1:2:",
					identities: {
						"*": ["policy1"]
					},
					policies: {
						"policy1": [{
							Effect: "Allow",
							Action: "*",
							Resource: "lrn:stuff:*"
						}, {
							Effect: "Allow",
							Action: "something:*",
							Resource: "stuff:*"
						}]
					}
				});
				let user = await sdk.authorize({
					requestContext: {
						identity: "identity-1234"
					}
				}, {
					lrn: "lrn:stuff:action-prefix:::ok",
					action: "get:thing"
				});

				assert.deepEqual(user.context, {});
				assert.deepEqual(user.identities, []);
				assert.deepEqual(user.identity_id, "*");

			})
		})
	});
});

