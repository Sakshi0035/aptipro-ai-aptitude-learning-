import express from 'express';
import { apiRouter } from '../server/api';

const app = express();
app.set('trust proxy', 1);
app.use('/api', apiRouter);
app.use('/', apiRouter);

export default app;
