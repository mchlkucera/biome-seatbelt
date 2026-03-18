// Bad file — multiple violations
// Expected violations:
//   lint/suspicious/noConsole: 3
//   lint/style/useConst: 2
//   lint/style/noNonNullAssertion: 1
//   lint/complexity/useLiteralKeys: 1

let name = "world";
let count = 42;
const obj = { foo: "bar", baz: 123 };

console.log("hello", name);
console.warn("count is", count);
console.error("obj is", obj);

const value = obj["foo"];
const result = null!;

export { name, count, value, result };
