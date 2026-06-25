// Vercel Speed Insights initialization
// This script enables Speed Insights tracking for the Zerodha Dashboard

(function() {
  // Initialize the Speed Insights queue
  window.si = window.si || function () {
    (window.siq = window.siq || []).push(arguments);
  };

  // Load the Speed Insights script from Vercel
  // This will be automatically configured when deployed to Vercel
  var script = document.createElement('script');
  script.defer = true;
  script.src = '/_vercel/speed-insights/script.js';
  
  // Append script to head
  document.head.appendChild(script);
})();
