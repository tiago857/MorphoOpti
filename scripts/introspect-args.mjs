// Introspect arguments of specific Query fields on the Morpho GraphQL API.
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

const { __type: q } = await gql(`{
  __type(name: "Query") {
    fields {
      name
      args { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } defaultValue }
    }
  }
}`);

const want = process.argv.slice(2).length ? process.argv.slice(2) : ["markets", "marketPositions", "userByAddress", "marketById"];
for (const f of q.fields.filter((f) => want.includes(f.name))) {
  console.log(`\n### Query.${f.name}`);
  for (const a of f.args) console.log(`  ${a.name}: ${typeName(a.type)}${a.defaultValue ? ` = ${a.defaultValue}` : ""}`);
}
