const required = [22, 13, 0];
const actual = process.versions.node.split(".").map(Number);
const meetsRequirement = actual[0] > required[0]
  || (actual[0] === required[0] && (actual[1] > required[1]
    || (actual[1] === required[1] && actual[2] >= required[2])));

if (!meetsRequirement) {
  console.error(`MedCollect requires Node.js >= ${required.join(".")}; found ${process.versions.node}.`);
  console.error("Set the Cloudflare Workers build environment to Node.js 22.13.0 or newer.");
  process.exit(1);
}

console.log(`Node.js ${process.versions.node} satisfies the build requirement.`);
