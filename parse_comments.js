const fs = require('fs');
const content = fs.readFileSync('C:\\Users\\taiph\\.gemini\\antigravity\\brain\\5ec0f6bc-05b1-424d-829e-2ab613f0f2b3\\.system_generated\\steps\\154\\output.txt', 'utf8');
const data = JSON.parse(content);

console.log('Total threads:', data.review_threads.length);
// Filter unresolved
const unresolved = data.review_threads.filter(t => !t.is_resolved);
console.log('Unresolved threads:', unresolved.length);

unresolved.forEach(t => {
  console.log('-----------------------------');
  console.log('Thread ID:', t.id);
  t.comments.forEach(c => {
    console.log(`Path: ${c.path}:${c.line}`);
    console.log(`Author: ${c.author}`);
    console.log(`Created: ${c.created_at}`);
    console.log(`Body: ${c.body}`);
  });
});
