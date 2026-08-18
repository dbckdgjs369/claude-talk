// 할 일 목록 상태 재구성.
//
// Claude Code는 할 일을 두 가지 방식으로 남긴다. 둘 다 받아야 한다.
//   TodoWrite            — 매번 목록 전체를 스냅샷으로 보냄 → 통째로 교체
//   TaskCreate/TaskUpdate — 생성·변경을 한 건씩 보냄 → 누적해서 재구성
//
// 그래서 "마지막 도구 호출만 보면 된다"가 성립하지 않는다. 세션 처음부터 순서대로 접어야
// 현재 상태가 나온다. jsonl 복원과 실시간 스트림 양쪽에서 같은 함수를 쓴다.

const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList']);

const isTaskTool = (name) => TASK_TOOLS.has(name);

const emptyTaskState = () => ({ items: [], seq: 0 });

const STATUSES = new Set(['pending', 'in_progress', 'completed']);
const normStatus = (s) => (STATUSES.has(s) ? s : 'pending');

// TodoWrite 항목은 content, Task*는 subject에 제목이 들어간다
const titleOf = (t) => String(t?.content || t?.subject || '').trim();

function applyTaskTool(state, name, input) {
  const st = state || emptyTaskState();
  const inp = input || {};

  if (name === 'TodoWrite') {
    const todos = Array.isArray(inp.todos) ? inp.todos : [];
    return {
      items: todos
        .map((t, i) => ({ id: String(i + 1), subject: titleOf(t), status: normStatus(t.status) }))
        .filter((t) => t.subject),
      seq: todos.length,
    };
  }

  if (name === 'TaskCreate') {
    const subject = titleOf(inp);
    if (!subject) return st;
    // id는 생성 순서대로 매긴다 — TaskUpdate가 참조하는 taskId와 같은 규칙
    const seq = st.seq + 1;
    return { items: [...st.items, { id: String(seq), subject, status: 'pending' }], seq };
  }

  if (name === 'TaskUpdate') {
    const id = String(inp.taskId ?? '');
    if (!id) return st;
    if (inp.status === 'deleted') {
      return { ...st, items: st.items.filter((t) => t.id !== id) };
    }
    return {
      ...st,
      items: st.items.map((t) =>
        t.id !== id
          ? t
          : {
              ...t,
              subject: inp.subject ? String(inp.subject).trim() : t.subject,
              status: inp.status ? normStatus(inp.status) : t.status,
            }
      ),
    };
  }

  return st; // TaskList는 조회일 뿐 — 상태를 바꾸지 않는다
}

// 도구 호출 목록을 처음부터 접어 현재 상태로
function foldTaskOps(ops) {
  let st = emptyTaskState();
  for (const op of ops || []) st = applyTaskTool(st, op.name, op.input);
  return st;
}

const taskSummary = (state) => ({
  items: state?.items || [],
  done: (state?.items || []).filter((t) => t.status === 'completed').length,
  total: (state?.items || []).length,
});

module.exports = { isTaskTool, emptyTaskState, applyTaskTool, foldTaskOps, taskSummary };
