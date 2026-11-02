const params = new URLSearchParams(location.search);
const noCache = window.REPLAYER_NO_CACHE === true
    || params.has('nocache')
    || params.get('cache') === '0';

const script = document.createElement('script');
script.type = 'module';
script.src = noCache ? `app.js?nocache=${Date.now()}` : 'app.js';
document.body.appendChild(script);
