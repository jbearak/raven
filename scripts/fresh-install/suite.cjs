// Mocha entry point loaded into the extension host by run.cjs. It runs only
// the getting-started tutorial test.
const path = require('path');

exports.run = function run() {
  const vscodeDir = path.join(__dirname, '..', '..', 'editors', 'vscode');
  const Mocha = require(path.join(vscodeDir, 'node_modules', 'mocha'));
  const mocha = new Mocha({ ui: 'tdd', color: false, timeout: 60000 });
  mocha.addFile(path.join(vscodeDir, 'out', 'test-getting-started', 'getting-started.test.js'));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures ? reject(new Error(`${failures} test(s) failed`)) : resolve()));
  });
};
