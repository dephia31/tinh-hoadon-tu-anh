import https from 'https';

https.get('https://tinh-hoadon-tu-anh.vercel.app/assets/index-IEqhsHnE.js', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    if (data.includes('process.env')) {
      console.log('process.env found in JS!');
      // Print the surrounding context
      const idx = data.indexOf('process.env');
      console.log(data.substring(Math.max(0, idx - 100), Math.min(data.length, idx + 100)));
    } else {
      console.log('process.env NOT found in JS.');
    }
    
    if (data.includes('ReferenceError')) {
      console.log('ReferenceError found in JS!');
    }
  });
}).on('error', (err) => {
  console.error(err);
});
