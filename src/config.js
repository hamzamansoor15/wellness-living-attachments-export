'use strict';

require('dotenv').config();

module.exports = {
  K_BUSINESS: process.env.K_BUSINESS || '643838',
  BASE_URL: 'https://www.wellnessliving.com',

  // Page paths
  LOGIN_PATH: '/login',
  ATTACHMENTS_PATH: '/Wl/Profile/Attach/AttachList.html',
  FORMS_REPORT_PATH: '/rs/report-render.html',

  // ASSUMPTION: Form response view URL. Verify by opening a completed form in the
  // WellnessLiving UI and checking the browser address bar, then update this path.
  FORM_VIEW_PATH: '/Wl/Quiz/QuizResponse.html',

  // Session health-check path — a lightweight authenticated page.
  SESSION_CHECK_PATH: '/rs/profile.html',

  // Forms date window — wide range to capture everything.
  FORMS_DATE_START: '2018-01-01',
  FORMS_DATE_END: '2031-12-31',

  // File system
  DOWNLOAD_DIR: process.env.DOWNLOAD_DIR || './downloads',
  CLIENTS_CSV: './clients.csv',
  PROGRESS_CSV: './progress.csv',
  ERROR_LOG: './error.log',

  // How many parallel browser tabs to use for processing.
  WORKER_COUNT: parseInt(process.env.WORKER_COUNT || '3', 10),

  // How many clients between session-validity checks.
  SESSION_REFRESH_INTERVAL: 200,

  USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',

  DELAYS: {
    BETWEEN_CLIENTS:    { MIN: 3000,  MAX: 6000  },
    BETWEEN_DOWNLOADS:  { MIN: 800,   MAX: 1800  },
    AFTER_LOGIN:        { MIN: 2000,  MAX: 3000  },
    AFTER_NAVIGATION:   { MIN: 1000,  MAX: 2500  },
    RETRY_FIRST:        { MIN: 8000,  MAX: 12000 },
    RETRY_SECOND:       { MIN: 20000, MAX: 30000 },
  },
};
