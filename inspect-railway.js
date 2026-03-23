// inspect-railway.js
// Run: RAILWAY_API_KEY=rly_your_token_here node inspect-railway.js

const RAILWAY_API_URL = "https://backboard.railway.com/graphql/v2";
const RAILWAY_API_KEY = process.env.RAILWAY_API_KEY;

if (!RAILWAY_API_KEY) {
    console.error("ERROR: Set RAILWAY_API_KEY environment variable first.");
    console.error("Usage: RAILWAY_API_KEY=rly_xxx node inspect-railway.js");
    process.exit(1);
}

async function introspect(typeName) {
    const query = `
        query IntrospectType($name: String!) {
            __type(name: $name) {
                name
                kind
                inputFields {
                    name
                    type {
                        name
                        kind
                        ofType {
                            name
                            kind
                        }
                    }
                    defaultValue
                }
            }
        }
    `;

    const res = await fetch(RAILWAY_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${RAILWAY_API_KEY}`,
        },
        body: JSON.stringify({ query, variables: { name: typeName } }),
    });

    const json = await res.json();
    return json.data?.__type;
}

async function introspectMutation(mutationName) {
    const query = `
        query IntrospectMutation {
            __schema {
                mutationType {
                    fields {
                        name
                        args {
                            name
                            type {
                                name
                                kind
                                ofType {
                                    name
                                    kind
                                }
                            }
                            defaultValue
                        }
                    }
                }
            }
        }
    `;

    const res = await fetch(RAILWAY_API_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${RAILWAY_API_KEY}`,
        },
        body: JSON.stringify({ query }),
    });

    const json = await res.json();
    const mutations = json.data?.__schema?.mutationType?.fields || [];
    return mutations.find((m) => m.name === mutationName);
}

async function main() {
    console.log("=".repeat(60));
    console.log("RAILWAY GRAPHQL SCHEMA INTROSPECTION");
    console.log("=".repeat(60));

    // 1. VolumeCreateInput fields
    console.log("\n--- VolumeCreateInput ---");
    const volumeCreateInput = await introspect("VolumeCreateInput");
    if (volumeCreateInput) {
        console.log(JSON.stringify(volumeCreateInput, null, 2));
    } else {
        console.log("Type not found.");
    }

    // 2. VolumeInstanceUpdateInput fields
    console.log("\n--- VolumeInstanceUpdateInput ---");
    const volumeInstanceInput = await introspect("VolumeInstanceUpdateInput");
    if (volumeInstanceInput) {
        console.log(JSON.stringify(volumeInstanceInput, null, 2));
    } else {
        console.log("Type not found.");
    }

    // 3. volumeCreate mutation signature
    console.log("\n--- volumeCreate mutation args ---");
    const volumeCreate = await introspectMutation("volumeCreate");
    if (volumeCreate) {
        console.log(JSON.stringify(volumeCreate, null, 2));
    } else {
        console.log("Mutation not found.");
    }

    // 4. volumeInstanceUpdate mutation signature
    console.log("\n--- volumeInstanceUpdate mutation args ---");
    const volumeInstanceUpdate = await introspectMutation("volumeInstanceUpdate");
    if (volumeInstanceUpdate) {
        console.log(JSON.stringify(volumeInstanceUpdate, null, 2));
    } else {
        console.log("Mutation not found.");
    }

    // 5. ServiceInstanceUpdateInput (in case volume mounts live here)
    console.log("\n--- ServiceInstanceUpdateInput ---");
    const serviceInstanceInput = await introspect("ServiceInstanceUpdateInput");
    if (serviceInstanceInput) {
        console.log(JSON.stringify(serviceInstanceInput, null, 2));
    } else {
        console.log("Type not found.");
    }

    console.log("\n" + "=".repeat(60));
    console.log("DONE. Copy the output above and share it.");
    console.log("=".repeat(60));
}

main().catch((err) => {
    console.error("Fatal error:", err.message);
    process.exit(1);
});
