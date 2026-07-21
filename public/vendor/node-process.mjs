/* Stands in for Node's `process` in the browser. The editor bundle reads
 * process.env to decide whether to log development warnings, and nothing
 * else — scripts/vendor-milkdown.js re-checks that on every vendor. */
export default { env: {} };
