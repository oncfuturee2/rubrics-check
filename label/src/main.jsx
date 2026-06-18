import React from 'react';
import ReactDOM from 'react-dom/client';
import LabelApp from './LabelApp.jsx';
import '../../src/styles.css';
import './label.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LabelApp />
  </React.StrictMode>,
);
