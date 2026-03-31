import https from 'https';

https.get('https://tinh-hoadon-tu-anh.vercel.app/assets/index-IEqhsHnE.js', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    let idx = data.indexOf('function Z_');
    if (idx === -1) idx = data.indexOf('Z_=');
    if (idx !== -1) {
      console.log(data.substring(Math.max(0, idx - 100), Math.min(data.length, idx + 100)));
    } else {
      console.log('Z_ not found');
    }
  });
}).on('error', (err) => {
  console.error(err);
});
