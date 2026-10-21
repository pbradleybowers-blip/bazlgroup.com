// Make a personal access code for the interview practice page.
// Usage: node scripts/make-code.mjs <person-id> ["Display name"]
// Prints the code (give it to the person) and the entry to add to the ACCESS_CODES secret
// on the bazl-interview Worker. Never commit real codes or the ACCESS_CODES value.
import { randomInt, randomBytes, createHash } from 'node:crypto';

const WORDS = `amber anchor apple arrow aspen atlas autumn badge bamboo banjo basil beacon birch bison bloom border breeze brick bridge brook bubble cabin cactus camel candle canyon carbon cedar cello chalk cherry cider cinder citrus clover cobalt comet copper coral cotton crane crater cricket crystal cypress daisy delta denim desert dollar dragon drift eagle echo ember falcon fern fiddle field flint forest fossil fox galaxy garden garnet ginger glacier globe granite grape gravel harbor hazel heron hickory honey horizon husky iris island ivory jasper jungle juniper kayak kettle kite lagoon lantern lava lemon lily linen lotus lunar magnet mango maple marble meadow melon meteor mint mirror monsoon moss mountain nectar nickel noble nutmeg oasis ocean olive onyx orbit orchid otter oyster paddle palm panda paper pearl pebble pepper pilot pine planet plaza plum polar pony prairie quartz quill rabbit radar raven reef ridge river robin rocket ruby saddle saffron salmon sand sapphire satin shadow shell sierra silver slate spruce squash star stone summit sunset swan tango thistle thunder tiger timber topaz tulip tundra turtle velvet violet walnut willow window winter yarrow zebra zephyr`.split(/\s+/);

const id = (process.argv[2] || '').trim();
const name = (process.argv[3] || '').trim();
if (!/^[a-z0-9][a-z0-9_-]{0,59}$/i.test(id) || id.toLowerCase() === 'brad') {
  console.error('Usage: node scripts/make-code.mjs <person-id> ["Display name"]\nThe id is letters, numbers, - or _, like tester4. "brad" is reserved for ACCESS_HASH.');
  process.exit(1);
}

const pick = () => WORDS[randomInt(WORDS.length)];
let a = pick(), b = pick();
while (b === a) b = pick();
const code = `${a}-${b}-${randomInt(100, 1000)}`;
const salt = randomBytes(16);
const hash = 'sha256:' + salt.toString('hex') + ':' + createHash('sha256').update(Buffer.concat([salt, Buffer.from(code)])).digest('hex');
const entry = name ? { hash, name } : hash;

console.log(`Person:  ${id}${name ? ' (' + name + ')' : ''}`);
console.log(`Code:    ${code}`);
console.log(`Hash:    ${hash}`);
console.log(`\nAdd this inside the ACCESS_CODES JSON object:\n  ${JSON.stringify(id)}: ${JSON.stringify(entry)}`);
