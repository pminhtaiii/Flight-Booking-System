const fs = require('fs');

const filePath = process.argv[2] || process.env.COMMENTS_FILE_PATH;

if (!filePath) {
  console.error('Error: Please provide the comments JSON file path as an argument or via the COMMENTS_FILE_PATH environment variable.');
  console.error('Usage: node parse_comments.js <path-to-json-file>');
  process.exit(1);
}

let content;
try {
  content = fs.readFileSync(filePath, 'utf8');
} catch (err) {
  console.error(`Error: Failed to read file at "${filePath}".`);
  console.error(err.message);
  process.exit(1);
}

let data;
try {
  data = JSON.parse(content);
} catch (err) {
  console.error('Error: Failed to parse file content as JSON. Ensure it is a valid JSON file.');
  console.error(err.message);
  process.exit(1);
}

if (!data || !Array.isArray(data.review_threads)) {
  console.error('Error: Invalid comments format. Expected an object containing a "review_threads" array.');
  process.exit(1);
}

console.log('Total threads:', data.review_threads.length);
// Filter unresolved
const unresolved = data.review_threads.filter(t => !t.is_resolved);
console.log('Unresolved threads:', unresolved.length);

unresolved.forEach(t => {
  console.log('-----------------------------');
  console.log('Thread ID:', t.id);
  if (Array.isArray(t.comments)) {
    t.comments.forEach(c => {
      console.log(`Path: ${c.path}:${c.line}`);
      console.log(`Author: ${c.author}`);
      console.log(`Created: ${c.created_at}`);
      console.log(`Body: ${c.body}`);
    });
  }
});
