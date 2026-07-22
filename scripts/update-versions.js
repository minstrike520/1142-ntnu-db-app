const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!version) {
  console.error('Error: Please provide a version number as the first argument.');
  process.exit(1);
}

const files = [
  path.join(__dirname, '../package.json'),
  path.join(__dirname, '../frontend/package.json'),
  path.join(__dirname, '../backend/package.json'),
];

files.forEach(file => {
  if (fs.existsSync(file)) {
    const rawData = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(rawData);
    data.version = version;
    
    // Write back with 2 spaces and trailing newline
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    console.log(`Successfully updated ${path.relative(process.cwd(), file)} to version ${version}`);
  } else {
    console.warn(`Warning: File not found: ${file}`);
  }
});
