import 'dotenv/config';
import path from 'node:path';
import express from 'express';
import { authAndPublicRouter } from './src/server/routes/authAndPublic.ts';
import { adminRouter } from './src/server/routes/adminRoutes.ts';
import { staffRouter } from './src/server/routes/staffRoutes.ts';
import { studentRouter } from './src/server/routes/studentRoutes.ts';
import { reportRouter } from './src/server/routes/reportRoutes.ts';
import { ensureBaselineSeeded } from './src/server/seed.ts';
import { startAttendanceScheduler } from './src/server/attendanceScheduler.ts';

const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));

  // Serve self-hosted free open-source @vladmandic/face-api neural weights
  const modelsDir = path.resolve(process.cwd(), 'node_modules/@vladmandic/face-api/model');
  app.use('/models', express.static(modelsDir, { maxAge: '7d' }));

  // Health probe
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'sbist-smart-attendance', timestamp: new Date().toISOString() });
  });

  // Domain API Routes
  app.use('/api', authAndPublicRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/staff', staffRouter);
  app.use('/api/student', studentRouter);
  app.use('/api/reports', reportRouter);

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SBIST Smart Attendance server listening on port ${PORT}`);
  });

  ensureBaselineSeeded()
    .then(() => {
      startAttendanceScheduler(30_000);
    })
    .catch((err) => {
      console.error('Background scheduler startup error:', err);
    });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
