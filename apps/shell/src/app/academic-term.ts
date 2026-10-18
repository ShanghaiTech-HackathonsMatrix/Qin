/** 上海高校春秋学期范围。只读宿主传入的时间，插件内不读取系统时钟。 */
export function currentAcademicTerm(now:number):string {
  const date=new Date(now+8*3600_000),month=date.getUTCMonth()+1,year=date.getUTCFullYear();
  return month===1?`Fall ${year-1}`:month<8?`Spring ${year}`:`Fall ${year}`;
}

/** 仅使用明确的课程学期，不用作业截止日期猜测课程归属。 */
export function courseTerm(value:string):string|null {
  const english=value.match(/\b(Fall|Spring|Summer|Winter)\s+(20\d{2})\b/i);
  const reversed=value.match(/\b(20\d{2})\s+(Fall|Spring|Summer|Winter)\b/i);
  const season=english?.[1]??reversed?.[2],year=english?.[2]??reversed?.[1];
  if(season)return `${season[0].toUpperCase()}${season.slice(1).toLowerCase()} ${year}`;
  const chinese=value.match(/(20\d{2})\s*[-–—/]\s*(20\d{2})\s*学年\s*([春秋夏冬])(?:季)?学期/);
  if(chinese && Number(chinese[2])===Number(chinese[1])+1)
    return `${({春:'Spring',秋:'Fall',夏:'Summer',冬:'Winter'} as Record<string,string>)[chinese[3]]} ${chinese[3]==='秋'?chinese[1]:chinese[2]}`;
  const numeric=value.match(/\b(20\d{2})-(20\d{2})-([12])\s*term\b/i);
  if(numeric && Number(numeric[2])===Number(numeric[1])+1)return numeric[3]==='1'?`Fall ${numeric[1]}`:`Spring ${numeric[2]}`;
  return null;
}

interface ScopedSnapshot {
  provider:string;courseScope?:string;
  courses:readonly {id:string;title:string;term?:string}[];
  assignments:readonly {courseId:string}[];
}
/** 所有显示/提醒路径共用；返回投影，不修改原始缓存和个人修正。 */
export function currentTermSnapshot<T extends ScopedSnapshot>(snapshot:T,now:number):T {
  if(snapshot.provider!=='blackboard' && snapshot.provider!=='gradescope')return snapshot;
  const term=currentAcademicTerm(now);
  const courses=snapshot.courses.filter(c=>snapshot.provider==='blackboard' && snapshot.courseScope!==undefined
    ?snapshot.courseScope===term
    :(courseTerm(c.term||c.title)===term));
  const ids=new Set(courses.map(c=>c.id));
  return {...snapshot,courses,assignments:snapshot.assignments.filter(a=>ids.has(a.courseId))};
}
