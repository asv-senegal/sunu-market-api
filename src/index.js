import { createApp } from './app.js';
import { config } from './config.js';

createApp().listen(config.port, () => console.log(`API Sunu-Market sur http://localhost:${config.port}`));
