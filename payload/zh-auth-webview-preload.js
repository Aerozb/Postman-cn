(function () {
  "use strict";

  try {
    var path = require("path");
    var localizerPath = path.join(__dirname, "zh-localize.js");
    var resolvedPath = require.resolve(localizerPath);
    delete require.cache[resolvedPath];
    require(resolvedPath);

    if (document && document.documentElement) {
      document.documentElement.setAttribute("data-postman-zh-auth-webview-preload", "true");
    }
  } catch (error) {
    try {
      console.warn("Postman zh auth webview preload failed", error);
    } catch (_) {}
  }
})();
