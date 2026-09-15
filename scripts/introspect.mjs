// Introspect the live Morpho GraphQL schema for the types we depend on.
async function gql(query, variables = {}) {
  const res = await fetch("https://api.morpho.org/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

const typeName = (t) => {
  if (!t) return "?";
  if (t.kind === "NON_NULL") return `${typeName(t.ofType)}!`;
  if (t.kind === "LIST") return `[${typeName(t.ofType)}]`;
  return t.name;
};

const TYPE_Q = `query($name: String!) {
  __type(name: $name) {
    name kind
    fields { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
    inputFields { name type { kind name ofType { kind name ofType { kind name } } } }
    enumValues { name }
  }
}`;

const targets = process.argv.slice(2);
const names = targets.length
  ? targets
  : ["Query", "Market", "MarketState", "MarketFilters", "MarketOrderBy", "MarketPosition", "MarketPositionState", "User", "MarketReward", "Asset"];

for (const name of names) {
  const { __type: t } = await gql(TYPE_Q, { name });
  if (!t) {
    console.log(`\n### ${name}: NOT FOUND`);
    continue;
  }
  console.log(`\n### ${t.name} (${t.kind})`);
  if (t.enumValues) console.log("  values: " + t.enumValues.map((v) => v.name).join(", "));
  for (const f of t.fields ?? []) console.log(`  ${f.name}: ${typeName(f.type)}`);
  for (const f of t.inputFields ?? []) console.log(`  in ${f.name}: ${typeName(f.type)}`);
}
