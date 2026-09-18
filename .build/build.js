const babel = require('@babel/core');
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, 'app.jsx');
const out = path.join(__dirname, '..', 'app.js');
// Resolve preset paths absolutely — bypasses Node 24 module-resolution glitches
// when running from inside .build/ (which lacks its own package.json entry hooks).
const presetEnvPath   = require.resolve('@babel/preset-env');
const presetReactPath = require.resolve('@babel/preset-react');
console.log('Reading:', src);
const code = fs.readFileSync(src, 'utf8');
const result = babel.transformSync(code, {
  presets: [
    [presetEnvPath,   { targets: '> 0.5%, last 2 versions, not dead' }],
    [presetReactPath, { runtime: 'classic' }]
  ],
  compact: true,
  comments: false,
  sourceMaps: false
});
fs.writeFileSync(out, result.code);
console.log('Wrote:', out, '(' + result.code.length + ' bytes)');
