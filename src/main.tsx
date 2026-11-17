import React from 'react';
import { createRoot } from 'react-dom/client';
import './ui/styles.css';
import { applyTheme } from './ui/kit';
import Root from './Root';

applyTheme();
createRoot(document.getElementById('root')!).render(<Root />);
