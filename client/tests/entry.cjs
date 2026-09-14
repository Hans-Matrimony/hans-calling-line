const React = require('react');
const { createRoot } = require('react-dom/client');
const Home = require('../app/page.tsx').default;
createRoot(document.getElementById('root')).render(React.createElement(Home));
