// Mixed file — some violations, some clean code
// Expected violations:
//   lint/suspicious/noConsole: 1
//   lint/style/useConst: 1

const PI = 3.14159;

let radius = 10;

function area(r: number): number {
  return PI * r * r;
}

console.log("area:", area(radius));

export { PI, radius, area };
