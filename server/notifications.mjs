import { randomUUID } from "node:crypto";

export function addNotification(db, userId, key, title, body, app = "", kind = "info") {
  if (!userId) return;
  db.prepare(`INSERT OR IGNORE INTO notifications(id,user_id,event_key,kind,title,body,app,created_at,read_at) VALUES(?,?,?,?,?,?,?,?,NULL)`)
    .run(randomUUID(), userId, key, kind, title.slice(0,160), body.slice(0,1000), app, new Date().toISOString());
}
const userForPerson = (db, personId) => personId && db.prepare("SELECT u.id FROM users u JOIN personnel p ON p.discord_id=u.discord_id WHERE p.id=? AND u.enabled=1").get(personId)?.id;

export function notifyAudit(db, auditId, actor, action, target, before, after) {
  const key = "audit:" + auditId;
  if (action === "aanvraag.ingediend") {
    addNotification(db, actor.id, key, "Aanvraag ontvangen", after?.title || "Je aanvraag wacht op beoordeling.", "requests");
  } else if (action === "aanvraag.beoordeeld") {
    const row = db.prepare("SELECT user_id,title,status FROM employee_requests WHERE id=?").get(target);
    if (row) addNotification(db, row.user_id, key, row.status === "approved" ? "Aanvraag goedgekeurd" : "Aanvraag afgewezen", row.title + (after?.reason ? " · " + after.reason : ""), "requests", row.status === "approved" ? "success" : "info");
  } else if (action.startsWith("opleiding.afronding_")) {
    const row = db.prepare("SELECT * FROM training_completions WHERE id=?").get(target) || before;
    if (row) {
      const name = db.prepare("SELECT name FROM training_courses WHERE id=?").get(row.course_id)?.name || "Opleiding";
      addNotification(db, row.user_id || userForPerson(db,row.personnel_id), key, "Opleidingenregister bijgewerkt", name + (action.endsWith("verwijderd") ? " · registratie verwijderd" : " · bekijk je registratie en bevoegdheid"), "training");
    }
  } else if (action.startsWith("roepnummer.")) {
    const row = db.prepare("SELECT * FROM callsigns WHERE id=?").get(target);
    const person = row?.personnel_id;
    if (person && (before?.personnel_id !== person || before?.number !== row.number))
      addNotification(db,userForPerson(db,person),key,"Roepnummer toegewezen", "Je roepnummer is " + row.number + (row.place ? " · " + row.place : ""), "police", "success");
    if (before?.personnel_id && before.personnel_id !== person)
      addNotification(db,userForPerson(db,before.personnel_id),key,"Roepnummer vrijgegeven","Je vorige roepnummer is niet meer aan je gekoppeld.","police");
  } else if (action.startsWith("personeel.")) {
    const row = db.prepare("SELECT p.id,c.number FROM personnel p LEFT JOIN callsigns c ON c.personnel_id=p.id WHERE p.id=?").get(target);
    if (row) addNotification(db,userForPerson(db,row.id),key,"Personeelsprofiel bijgewerkt",row.number ? "Je huidige roepnummer is " + row.number : "Je personeelsgegevens zijn bijgewerkt.","police");
  }
}

export function installNotifications(app, { db, auth }) {
  app.get("/api/notifications", auth.auth, (req,res) => {
    const grants=req.auth.grants;
    if (grants.admin || grants.policeWrite || grants.ambulanceWrite) {
      for (const row of db.prepare("SELECT id,title,service FROM employee_requests WHERE status='pending' AND user_id<>?").all(req.auth.user.id)) {
        if (grants.admin || (row.service==='police' && grants.policeWrite) || (row.service==='ambulance' && grants.ambulanceWrite))
          addNotification(db,req.auth.user.id,"review:"+row.id,"Aanvraag wacht op beoordeling",row.title,"requests");
      }
    }
    res.json({items:db.prepare("SELECT id,kind,title,body,app,created_at,read_at FROM notifications WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 100").all(req.auth.user.id),unread:db.prepare("SELECT count(*) n FROM notifications WHERE user_id=? AND read_at IS NULL").get(req.auth.user.id).n});
  });
  app.post("/api/notifications/read-all",auth.auth,auth.csrf,(req,res)=>{
    db.prepare("UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL").run(new Date().toISOString(),req.auth.user.id);res.json({ok:true});
  });
  app.post("/api/notifications/:id/read",auth.auth,auth.csrf,(req,res)=>{
    const result=db.prepare("UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?").run(new Date().toISOString(),req.params.id,req.auth.user.id);
    if(!result.changes)return res.status(404).json({error:"Melding niet gevonden."});res.json({ok:true});
  });
}
