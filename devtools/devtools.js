// Create DevTools panel
chrome.devtools.panels.create(
  'TurboMock',
  '/assets/icons/icon-16.png',
  '/devtools/panel.html',
  function (panel) {
    console.log('TurboMock DevTools panel created');
  }
);

// Listen for network events
chrome.devtools.network.onRequestFinished.addListener(function (request) {
  const isMocked =
    request.response &&
    request.response.headers &&
    request.response.headers.some(
      (h) => h.name.toLowerCase() === 'x-turbomock' && h.value === 'true'
    );

  if (isMocked) {
    console.log('TurboMock: Detected mocked request', request.request.url);
  }
});
