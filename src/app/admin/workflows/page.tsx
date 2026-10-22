import { redirect } from 'next/navigation';

/**
 * The standalone Workflows page was folded into Task Management
 * (admin nav audit, slice 13): a workflow is a virtual aggregate over
 * task docs sharing a workflowId, workflows are created and edited from
 * the task form's Workflow Plan section, and the mission rollup — list,
 * progress, expandable steps, mission PDF export, duplicate and
 * cascade-delete — now lives in the Missions tab of /admin/tasks.
 * This route stays as a redirect for old bookmarks.
 */
export default function AdminWorkflowsPage() {
  redirect('/admin/tasks?tab=missions');
}
