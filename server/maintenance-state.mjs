export function effectiveMaintenance(settings, now = Date.now()) {
  const manual=settings.maintenance;
  const schedule=settings.maintenanceSchedule;
  const start=Date.parse(schedule?.startsAt),end=Date.parse(schedule?.endsAt);
  const scheduled=Number.isFinite(start)&&(!schedule.endsAt||Number.isFinite(end))&&(!schedule.endsAt||end>start)&&(!schedule.endsAt||now<end)
    ? {id:schedule.id,startsAt:schedule.startsAt,endsAt:schedule.endsAt||null,reason:String(schedule.reason||"").slice(0,500)} : null;
  const active=scheduled&&now>=start;
  const enabled=manual?.enabled===true||Boolean(active);
  return {enabled,reason:manual?.enabled===true?String(manual.reason||""):active?scheduled.reason:"",updatedAt:manual?.updatedAt||null,...(scheduled?{scheduled}: {})};
}
