// Undo/redo stack for mutating actions (edits, moves, re-parents, dep links,
// sprint moves, creates). Relocated from app.js (bare, no IIFE) as Task B.
// pushAction + afterUndo are called bare from board/bulk/dependencies/editor/
// sprint-edit; runStep is their shared engine; runUndo/runRedo are called bare
// from command-palette.js and app.js (keyboard + toolbar buttons). So the whole
// module stays bare — pure relocation, zero call-site churn. Relies on bare
// globals resolved at call time: $, refresh, App.state.cur, openItem, setStatus,
// loadStart, loadEnd.
/* ---------- undo / redo (Ctrl/Cmd+Z · Ctrl/Cmd+Shift+Z or Ctrl+Y) ----------
   Each mutating action pushes a command with matching undo()/redo() functions,
   run via the raw api (so they never re-record themselves). A new action clears
   the redo stack. Undoing a create deletes the item (ADO Recycle Bin — still
   recoverable); redoing it re-creates it (new id, rebound for a later undo). */
const undoStack=[],redoStack=[];let undoBusy=false;
function pushAction(label,undo,redo){
  undoStack.push({label,undo,redo});if(undoStack.length>50)undoStack.shift();
  redoStack.length=0;updateUndoButtons();
}
async function afterUndo(id){await refresh();if(id!=null&&App.state.cur===id)openItem(id);}
async function runStep(from,to,verb){
  if(undoBusy)return;
  const e=from.pop();
  if(!e){setStatus('nothing to '+verb);return;}
  undoBusy=true;loadStart(verb+'ing: '+e.label+'…');
  try{await (verb==='undo'?e.undo:e.redo)();to.push(e);setStatus((verb==='undo'?'undid: ':'redid: ')+e.label);}
  catch(err){from.push(e);setStatus(verb+' failed ('+e.label+'): '+err.message,true);}
  finally{undoBusy=false;loadEnd();updateUndoButtons();}
}
const runUndo=()=>runStep(undoStack,redoStack,'undo');
const runRedo=()=>runStep(redoStack,undoStack,'redo');
function updateUndoButtons(){
  const u=$('undobtn'),r=$('redobtn');
  if(u)u.disabled=!undoStack.length;
  if(r)r.disabled=!redoStack.length;
}
