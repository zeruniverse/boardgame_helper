const fs = require('fs');
const path = require('path');

// 读取 townsquare 的角色数据
const townsquareRoles = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../sample/townsquare/src/roles.json'), 'utf8')
);

// 中文翻译映射
const translations = {
  // Trouble Brewing
  washerwoman: '洗衣妇',
  librarian: '图书管理员',
  investigator: '调查员',
  chef: '厨师',
  empath: '共情者',
  fortuneteller: '占卜师',
  undertaker: '殡仪员',
  monk: '僧侣',
  ravenkeeper: '乌鸦饲养员',
  virgin: '处女',
  slayer: '杀手',
  soldier: '士兵',
  mayor: '镇长',
  butler: '管家',
  drunk: '酒鬼',
  recluse: '隐士',
  saint: '圣徒',
  poisoner: '投毒者',
  spy: '间谍',
  scarletwoman: '红颜',
  baron: '男爵',
  imp: '小恶魔',
  
  // 旅行者
  bureaucrat: '官僚',
  thief: '盗贼',
  gunslinger: '枪手',
  scapegoat: '替罪羊',
  beggar: '乞丐',
  
  // Bad Moon Rising
  grandmother: '祖母',
  sailor: '水手',
  chambermaid: '侍女',
  exorcist: '驱魔师',
  innkeeper: '酒馆老板',
  gambler: '赌徒',
  gossip: '八卦',
  courtier: '朝臣',
  professor: '教授',
  minstrel: '吟游诗人',
  teaLady: '茶艺师',
  pacifist: '和平主义者',
  fool: '愚者',
  tinker: '修补匠',
  moonchild: '月之子',
  goon: '暴徒',
  lunatic: '疯子',
  godfather: '教父',
  devilsadvocate: '恶魔的拥护者',
  assassin: '暗杀者',
  mastermind: '幕后黑手',
  zombuul: '僵尸',
  pukka: '普卡',
  shabaloth: '沙巴洛斯',
  po: '破',
  
  // Sects & Violets
  clockmaker: '钟表匠',
  dreamer: '梦想家',
  snakeccharmer: '弄蛇人',
  mathematician: '数学家',
  flowergirl: '花女孩',
  towncrier: '报信者',
  oracle: '神谕者',
  savant: '学者',
  seamstress: '女裁缝',
  philosopher: '哲学家',
  artist: '艺术家',
  juggler: '杂耍演员',
  sage: '智者',
  mutant: '变种人',
  sweetheart: '甜心',
  barber: '理发师',
  klutz: '笨蛋',
  eviltwin: '邪恶双子',
  witch: '女巫',
  cerenovus: '塞雷诺维斯',
  pitHag: '深渊女巫',
  fanggu: '彊尸',
  vigormortis: '维格莫提斯',
  nodashii: '诺达希',
  vortox: '沃托克斯'
};

// 转换函数
function translateRole(role) {
  return {
    id: role.id,
    name: translations[role.id] || role.name,
    edition: role.edition,
    team: role.team,
    firstNight: role.firstNight,
    firstNightReminder: role.firstNightReminder,
    otherNight: role.otherNight,
    otherNightReminder: role.otherNightReminder,
    reminders: role.reminders || [],
    remindersGlobal: role.remindersGlobal,
    setup: role.setup,
    ability: role.ability,
    isCustom: false
  };
}

// 分组角色
const rolesByEdition = {
  tb: [],
  bmr: [],
  snv: [],
  traveler: []
};

townsquareRoles.forEach(role => {
  const translatedRole = translateRole(role);
  
  if (role.team === 'traveler') {
    rolesByEdition.traveler.push(translatedRole);
  } else if (role.edition === 'tb') {
    rolesByEdition.tb.push(translatedRole);
  } else if (role.edition === 'bmr') {
    rolesByEdition.bmr.push(translatedRole);
  } else if (role.edition === 'snv') {
    rolesByEdition.snv.push(translatedRole);
  }
});

// 生成 TypeScript 文件内容
const tsContent = `import { Role, Edition, Team } from './botcTypes';

/**
 * 血染钟楼游戏数据 - 完整版本
 * 包含三个官方剧本的所有角色和旅行者角色
 */

export const EDITIONS: Edition[] = [
  {
    id: "tb",
    name: "Trouble Brewing",
    author: "The Pandemonium Institute",
    description: "初学者版本，适合新手玩家",
    level: "Beginner",
    roles: [${rolesByEdition.tb.map(r => `"${r.id}"`).join(', ')}],
    isOfficial: true
  },
  {
    id: "bmr",
    name: "Bad Moon Rising",
    author: "The Pandemonium Institute", 
    description: "中级版本，包含更复杂的角色机制",
    level: "Intermediate",
    roles: [${rolesByEdition.bmr.map(r => `"${r.id}"`).join(', ')}],
    isOfficial: true
  },
  {
    id: "snv",
    name: "Sects & Violets",
    author: "The Pandemonium Institute",
    description: "中级版本，注重信息操控和疯狂机制",
    level: "Intermediate", 
    roles: [${rolesByEdition.snv.map(r => `"${r.id}"`).join(', ')}],
    isOfficial: true
  }
];

// 旅行者角色（可在任何版本中使用）
export const TRAVELER_ROLES: Role[] = ${JSON.stringify(rolesByEdition.traveler, null, 2)};

// 所有角色数据
export const ROLES: Role[] = [
  // Trouble Brewing
  ${rolesByEdition.tb.map(role => `  ${JSON.stringify(role, null, 2)}`).join(',\\n')},
  
  // Bad Moon Rising
  ${rolesByEdition.bmr.map(role => `  ${JSON.stringify(role, null, 2)}`).join(',\\n')},
  
  // Sects & Violets
  ${rolesByEdition.snv.map(role => `  ${JSON.stringify(role, null, 2)}`).join(',\\n')},
  
  // 旅行者
  ...TRAVELER_ROLES
];

// 夜晚行动顺序
export const NIGHT_ORDER = {
  first: [
    ${townsquareRoles.filter(r => r.firstNight > 0).sort((a, b) => a.firstNight - b.firstNight).map(r => `"${r.id}"`).join(',\\n    ')}
  ],
  other: [
    ${townsquareRoles.filter(r => r.otherNight > 0).sort((a, b) => a.otherNight - b.otherNight).map(r => `"${r.id}"`).join(',\\n    ')}
  ]
};

// 工具函数
export const getRolesByEdition = (editionId: string): Role[] => {
  return ROLES.filter(role => role.edition === editionId || role.team === Team.TRAVELER);
};

export const getEditionById = (editionId: string): Edition | undefined => {
  return EDITIONS.find(edition => edition.id === editionId);
};

export const getRolesByTeam = (editionId: string, team: Team): Role[] => {
  return getRolesByEdition(editionId).filter(role => role.team === team);
};

export const getRoleById = (roleId: string): Role | undefined => {
  return ROLES.find(role => role.id === roleId);
};

export const getAllRoles = (): Role[] => {
  return ROLES;
};
`;

// 写入文件
fs.writeFileSync(
  path.join(__dirname, '../backend/src/utils/botcDataComplete.ts'),
  tsContent
);

console.log('完整的 BOTC 数据文件已生成！'); 