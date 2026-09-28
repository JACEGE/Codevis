import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import StandaloneKanban from './components/StandaloneKanban';
import './demo-theme.css';
import setupErrorReporter from './utils/errorReporter';
import BRIDGE_URL from './bridgeUrl';

// Init global error tracking (tags the erroring node in the code graph)
setupErrorReporter(BRIDGE_URL);

// URL-based routing: ?view=kanban shows the Kanban board
const params = new URLSearchParams(window.location.search);
const view = params.get('view');

const render = () => ReactDOM.createRoot(document.getElementById('root')).render(
    view === 'kanban' ? <StandaloneKanban /> : <App />
);

// The demo build replays a recorded bridge instead of connecting to one. The
// condition is a build-time constant, so regular builds drop this branch.
if (import.meta.env.VITE_DEMO === '1') {
    import('./demo/installDemo.js').then(({ installDemo }) => installDemo()).then(render);
} else {
    render();
}
