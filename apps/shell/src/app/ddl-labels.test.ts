import {strict as assert} from 'node:assert';
import {test} from 'node:test';
import {compactAssignmentName,compactCourseName,compactDdlLabels} from './ddl-labels.ts';

test('课程仅去掉明确学期，保留方向、班级和课程编号',()=>{
  assert.equal(compactCourseName('高等数学（2026秋）'),'高等数学');
  assert.equal(compactCourseName('CS101 数据结构 [Fall 2026]'),'CS101 数据结构');
  assert.equal(compactCourseName('大学物理（实验班）'),'大学物理（实验班）');
  assert.equal(compactCourseName('2026秋'),'2026秋');
  assert.equal(compactCourseName('数据结构 CS101 2025-2026学年秋季学期'),'数据结构 CS101');
  assert.equal(compactCourseName('普通物理I 2025春赵班 PHYS1181 2024-2025学年春季学期'),'普通物理I 2025春赵班 PHYS1181');
  assert.equal(compactCourseName('CS101 · 2026-2027学年第一学期'),'CS101');
});
test('编号写法归一，保留分组、报告、补交、范围与未知后缀',()=>{
  for(const [raw,want] of [['Homework 02','HW2'],['Problem Set 3','PS3'],['Lab 4 Report','Lab4 报告'],['Homework 3 Part B','HW3-B'],['HW 2-3','HW2-3'],['Homework 2 补交','HW2 补交'],['Homework 2 Solutions','HW2 Solutions'],['期中论文','期中论文'],['作业 02','作业2']]) assert.equal(compactAssignmentName(raw),want);
  assert.equal(compactAssignmentName('高等数学 · Homework 02','高等数学（2026秋）'),'HW2');
  assert.equal(compactAssignmentName('HW2 Part A'),'HW2-A');
  assert.equal(compactAssignmentName('上载作业： Homework 02'),'HW2');
  assert.equal(compactAssignmentName('上载作业： lecture3_additional_credit'),'lecture3_additional_credit');
  assert.equal(compactAssignmentName('上传作业：'),'上传作业：');
  assert.equal(compactAssignmentName('Homework_02'),'HW2');
});
test('缩写冲突恢复区别信息，个人命名及本机任务保持原样，不修改输入',()=>{
  const rows=[
    {id:'1',provider:'bb',courseTitle:'数学（2026秋）',title:'Homework 02'},
    {id:'2',provider:'bb',courseTitle:'数学（2026秋）',title:'HW2'},
    {id:'3',provider:'bb',courseTitle:'数学（2026春）',title:'Homework 03'},
    {id:'4',provider:'bb',courseTitle:'物理',title:'Homework 04',titleEdited:true},
    {id:'5',title:'Homework 05',courseTitle:'自建（2026秋）'},
  ];
  const before=JSON.stringify(rows),labels=compactDdlLabels(rows);
  assert.equal(labels.get('1')?.title,'Homework 02');
  assert.equal(labels.get('1')?.course,'数学（2026秋）');
  assert.equal(labels.get('3')?.course,'数学（2026春）');
  assert.equal(labels.get('4')?.title,'Homework 04');
  assert.deepEqual(labels.get('5'),{title:'Homework 05',course:'自建（2026秋）'});
  assert.equal(JSON.stringify(rows),before);
});
