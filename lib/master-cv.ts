import type {
  TailoredCV,
  TailoredCVExperienceItem,
  TailoredCVToolboxCategory,
} from './types';

export interface MasterExperienceEntry extends TailoredCVExperienceItem {
  authenticContext: string;
}

export const MASTER_CV = {
  name: 'Eden Hadad',
  title: 'Data Analyst | B.Sc. Industrial Engineering & Management',
  contact: {
    location: 'Givatayim, Israel',
    email: 'edenhadad70@gmail.com',
    phone: '054-9451235',
    linkedinLabel: 'LinkedIn',
    linkedinUrl: process.env.NEXT_PUBLIC_LINKEDIN_URL || '',
    githubLabel: 'GitHub',
    githubUrl: process.env.NEXT_PUBLIC_GITHUB_URL || '',
  },
  defaultSummary:
    'Data Analyst with 5+ years of experience turning complex product, e-commerce, and time-series data into actionable insights, predictive ML models, and executive BI dashboards using SQL, Python, and modern analytics stacks.',
  experience: [
    {
      role: 'Data Analyst & AI Solutions',
      company: 'Freelance & Independent Projects',
      period: 'Mar 2023 – Present',
      bullets: [
        'Delivered end-to-end data solutions, custom BI dashboards, and predictive models for private clients.',
        'Analyzed high-frequency event streams and time-series datasets using Python (Pandas, NumPy).',
        'Integrated LLMs and automated AI workflows to accelerate data pipelines and reporting.',
      ],
      authenticContext:
        'Delivered end-to-end data solutions, custom BI dashboards, and predictive models for private clients/freelance; analyzed high-frequency event streams and time-series data in Python (Pandas, NumPy); integrated LLMs and automated AI workflows to accelerate data pipelines.',
    },
    {
      role: 'Data Analyst / Data Scientist',
      company: 'Montara (Startup)',
      period: 'Sep 2021 – Feb 2023',
      bullets: [
        'Led product data research on high-dimensional user interaction data to detect anomalies and optimize features.',
        'Built production ML classification models achieving +15% improvement in prediction accuracy.',
        'Built automated KPI monitoring dashboards and partnered on scalable SQL, Python, and Airflow ETL pipelines.',
      ],
      authenticContext:
        'Led product data research on high-dimensional user interaction data to detect anomalies and optimize features; built production ML classification models (+15% prediction accuracy); built automated KPI tracking/monitoring dashboards reducing bug response time; partnered with Data Engineering on scalable ETL pipelines (SQL, Python, Apache Airflow).',
    },
    {
      role: 'Data Analyst',
      company: 'Shufersal (E-commerce)',
      period: 'Jun 2020 – Sep 2021',
      bullets: [
        'Queried multi-million-row databases with advanced SQL (Window Functions, CTEs, Complex Joins) and Excel.',
        'Partnered with VPs, Marketing, and Product teams to design and deliver executive BI dashboards.',
        'Developed an end-to-end predictive customer purchasing model that improved marketing campaign ROI.',
      ],
      authenticContext:
        'Queried multi-million-row databases using advanced SQL (Window Functions, CTEs, Complex Joins) and Excel; built executive dashboards with VPs, Marketing, and Product; developed an end-to-end predictive customer purchasing model improving campaign ROI.',
    },
  ] as [MasterExperienceEntry, MasterExperienceEntry, MasterExperienceEntry],
  education: [
    'B.Sc. Industrial Engineering & Management — Ben-Gurion University (2016–2020)',
    'G-Academy — PySpark & Python for Data Science',
  ],
  toolboxList: [
    'SQL (PostgreSQL, MySQL, BigQuery)',
    'Python (Pandas, NumPy, Scikit-Learn)',
    'Tableau',
    'Power BI',
    'Metabase',
    'A/B Testing',
    'Hypothesis Testing',
    'Predictive Modeling',
    'Anomaly Detection',
    'Apache Airflow',
    'PySpark',
    'Git',
    'Docker',
    'LLM Automation',
    'Excel',
  ],
  defaultToolbox: [
    {
      category: 'Data & Languages',
      items: 'SQL (PostgreSQL, MySQL, BigQuery), Python (Pandas, NumPy, Scikit-Learn), Excel',
    },
    {
      category: 'BI & Visualization',
      items: 'Tableau, Power BI, Metabase, Executive KPI Dashboards',
    },
    {
      category: 'Analytics & ML',
      items: 'A/B Testing, Hypothesis Testing, Predictive Modeling, Anomaly Detection',
    },
    {
      category: 'Data Engineering & AI',
      items: 'Apache Airflow, PySpark, Git, Docker, LLM Automation',
    },
  ] as [
    TailoredCVToolboxCategory,
    TailoredCVToolboxCategory,
    TailoredCVToolboxCategory,
    TailoredCVToolboxCategory,
  ],
} as const;

export function getDefaultMasterCvTemplate(): TailoredCV {
  return {
    summary: MASTER_CV.defaultSummary,
    experience: MASTER_CV.experience.map((item) => ({
      role: item.role,
      company: item.company,
      period: item.period,
      bullets: [...item.bullets],
    })),
    toolbox: MASTER_CV.defaultToolbox.map((group) => ({
      category: group.category,
      items: group.items,
    })),
    education: [...MASTER_CV.education],
  };
}
