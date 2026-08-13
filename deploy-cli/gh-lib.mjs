import { listWorkflows } from "./gh-actions.mjs";

export async function resolveWorkflow(token, repo, workflowRef) {
  const value = String(workflowRef);
  if (/^\d+$/.test(value)) return value;
  const workflows = await listWorkflows(token, repo);
  const match = workflows.find(
    (workflow) =>
      workflow.path === value
      || workflow.name === value
      || workflow.path.endsWith(`/${value}.yml`)
      || workflow.path.endsWith(`/${value}.yaml`),
  );
  if (!match) {
    throw new Error(`workflow "${value}" không tìm thấy trong ${repo} — chạy list-workflows để xem các file yml`);
  }
  return match.path;
}