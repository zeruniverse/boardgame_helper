const ROLE_NAMES_ZH: Record<string, string> = {
  bureaucrat: '官僚', thief: '盗贼', gunslinger: '枪手', scapegoat: '替罪羊', beggar: '乞丐',
  apprentice: '学徒', matron: '女舍监', judge: '法官', bishop: '主教', voudon: '巫毒师',
  barista: '咖啡师', harlot: '交际花', butcher: '屠夫', bonecollector: '骨骸收集者',
  deviant: '异端', gangster: '黑帮',
  washerwoman: '洗衣妇', librarian: '图书管理员', investigator: '调查员', chef: '厨师',
  empath: '共情者', fortuneteller: '占卜师', undertaker: '殡仪员', monk: '僧侣',
  ravenkeeper: '乌鸦饲养员', virgin: '处女', slayer: '杀手', soldier: '士兵', mayor: '镇长',
  butler: '管家', drunk: '酒鬼', recluse: '隐士', saint: '圣徒', poisoner: '投毒者',
  spy: '间谍', scarletwoman: '红颜', baron: '男爵', imp: '小恶魔',
  grandmother: '祖母', sailor: '水手', chambermaid: '侍女', exorcist: '驱魔师',
  innkeeper: '酒馆老板', gambler: '赌徒', gossip: '八卦', courtier: '朝臣', professor: '教授',
  minstrel: '吟游诗人', tealady: '茶艺师', pacifist: '和平主义者', fool: '愚者', tinker: '修补匠',
  moonchild: '月之子', goon: '暴徒', lunatic: '疯子', godfather: '教父',
  devilsadvocate: '恶魔律师', assassin: '暗杀者', mastermind: '幕后黑手', zombuul: '僵怖',
  pukka: '普卡', shabaloth: '沙巴洛斯', po: '破',
  clockmaker: '钟表匠', dreamer: '梦想家', snakecharmer: '弄蛇人', mathematician: '数学家',
  flowergirl: '花女孩', towncrier: '报信者', oracle: '神谕者', savant: '学者', seamstress: '女裁缝',
  philosopher: '哲学家', artist: '艺术家', juggler: '杂耍演员', sage: '智者', mutant: '变种人',
  sweetheart: '甜心', barber: '理发师', klutz: '笨蛋', eviltwin: '邪恶双子', witch: '女巫',
  cerenovus: '塞雷诺维斯', pithag: '深渊女巫', fanggu: '方古', vigormortis: '维格莫提斯',
  nodashii: '诺达希', vortox: '沃托克斯'
};

const ROLE_ABILITIES_ZH: Record<string, string> = {
  washerwoman: '开局得知两名玩家中有一名特定镇民。',
  librarian: '开局得知两名玩家中有一名特定外来者，或得知场上没有外来者。',
  investigator: '开局得知两名玩家中有一名特定爪牙。',
  chef: '开局得知相邻邪恶玩家对数。',
  empath: '每晚得知两名存活邻座中邪恶玩家的数量。',
  fortuneteller: '每晚选择两名玩家，得知其中是否有恶魔。',
  undertaker: '每晚得知当天被处决玩家的角色。',
  monk: '每晚选择另一名玩家，使其当晚免受恶魔伤害。',
  ravenkeeper: '若在夜晚死亡，可选择一名玩家并得知其角色。',
  virgin: '首次被镇民提名时，提名者立即被处决。',
  slayer: '每局一次，白天公开选择一名玩家；若其为恶魔则死亡。',
  soldier: '恶魔无法杀死你。',
  mayor: '若仅剩三名玩家且白天无人被处决，善良阵营获胜；夜晚死亡可能转移。',
  butler: '每晚选择一名主人；次日只能在主人投票时投票。',
  drunk: '你不知道自己是酒鬼，并以为自己是一个镇民，但没有该能力。',
  recluse: '你可能被登记为邪恶、爪牙或恶魔，即使已经死亡。',
  saint: '若你被处决，善良阵营落败。',
  poisoner: '每晚选择一名玩家，使其在当晚和次日中毒。',
  spy: '每晚查看魔典；你可能被登记为善良角色。',
  scarletwoman: '存活玩家不少于五人时，若恶魔死亡，你会成为恶魔。',
  baron: '场上额外加入两名外来者。',
  imp: '每晚选择一名玩家死亡；选择自己时，一名存活爪牙成为小恶魔。',
  grandmother: '开局得知一名善良玩家及其角色；若恶魔杀死该玩家，你也会死亡。',
  sailor: '每晚选择一名存活玩家，你或对方会醉酒；你清醒时不会死亡。',
  chambermaid: '每晚选择两名存活玩家，得知今晚因能力醒来的玩家数量。',
  exorcist: '每晚选择与昨晚不同的玩家；若选中恶魔，恶魔当晚不能行动。',
  innkeeper: '每晚选择两名玩家，使其当晚不会死亡，但其中一人醉酒。',
  gambler: '每晚选择一名玩家并猜其角色；猜错时你死亡。',
  gossip: '每天可公开发表一个陈述；若为真，当晚一名玩家死亡。',
  courtier: '每局一次，选择一个角色，使其醉酒三昼夜。',
  professor: '每局一次，夜晚选择一名死亡镇民，使其复活。',
  minstrel: '若爪牙被处决，除你和旅行者外所有玩家醉酒至次日黄昏。',
  tealady: '若你的两名存活邻座都是善良，他们不会死亡。',
  pacifist: '被处决的善良玩家可能不会死亡。',
  fool: '你第一次死亡时不会死亡。',
  tinker: '你随时可能死亡。',
  moonchild: '得知自己死亡后选择一名存活玩家；若其善良，他在当晚死亡。',
  goon: '每晚首个以能力选择你的玩家醉酒，你加入其阵营。',
  lunatic: '你以为自己是恶魔，但实际上不是；真正的恶魔知道你及你的选择。',
  godfather: '开局得知在场外来者；若白天有外来者死亡，当晚可杀死一名玩家。',
  devilsadvocate: '每晚选择与昨晚不同的存活玩家，使其次日被处决也不会死亡。',
  assassin: '每局一次，夜晚选择一名玩家，使其死亡，即使受到保护。',
  mastermind: '若恶魔被处决，游戏继续一天；若次日有玩家被处决，邪恶阵营获胜。',
  zombuul: '你第一次死亡时仍被登记为死亡；若白天无人死亡，你可在夜晚杀人。',
  pukka: '每晚选择一名玩家中毒；上一晚被你中毒的玩家随后死亡并恢复。',
  shabaloth: '每晚选择两名玩家死亡；前一晚被你杀死的玩家可能复活。',
  po: '每晚可不选人以蓄力；下一晚可选择三名玩家死亡。',
  clockmaker: '开局得知恶魔与最近爪牙之间的距离。',
  dreamer: '每晚选择一名玩家，得知一个可能正确和一个错误角色。',
  snakecharmer: '每晚选择一名存活玩家；若其为恶魔，你们交换角色与阵营。',
  mathematician: '每晚得知因其他角色能力异常而受到影响的玩家数量。',
  flowergirl: '每晚得知恶魔在当天是否投过票。',
  towncrier: '每晚得知爪牙在当天是否发起过提名。',
  oracle: '每晚得知死亡玩家中邪恶玩家的数量。',
  savant: '每天获得两条信息，其中一真一假。',
  seamstress: '每局一次，夜晚选择两名玩家，得知他们是否同阵营。',
  philosopher: '每局一次，获得一个善良角色的能力；若该角色在场，其玩家醉酒。',
  artist: '每局一次，白天向说书人提出一个是非问题。',
  juggler: '首日公开猜测若干玩家角色；当晚得知猜对数量。',
  sage: '若恶魔杀死你，你会得知恶魔是两名玩家之一。',
  mutant: '若你疯狂声称自己是外来者，可能被处决。',
  sweetheart: '你死亡时，一名玩家开始醉酒。',
  barber: '你死亡时，恶魔可在当晚交换两名玩家的角色。',
  klutz: '得知自己死亡后选择一名存活玩家；若其邪恶，善良阵营落败。',
  eviltwin: '你与一名对立阵营玩家互相知道；善良双子被处决时邪恶阵营获胜。',
  witch: '每晚选择一名玩家；若其次日提名，他会死亡。',
  cerenovus: '每晚选择一名玩家和一个善良角色，使其次日必须疯狂声称该角色。',
  pithag: '每晚选择一名玩家和一个角色，将其变成该角色；恶魔变化时死亡由说书人决定。',
  fanggu: '每晚选择一名玩家死亡；首次杀死外来者时，外来者成为方古而你死亡。',
  vigormortis: '每晚选择一名玩家死亡；被你杀死的爪牙保留能力，并使邻近镇民中毒。',
  nodashii: '每晚选择一名玩家死亡；与你相邻的镇民中毒。',
  vortox: '每晚选择一名玩家死亡；镇民能力必须得到错误信息，每天必须有人被处决。'
};

const containsChinese = (value: string): boolean => /[\u3400-\u9fff]/.test(value);

export function getBOTCRoleName(roleId?: string, providedName?: string): string {
  const normalizedId = String(roleId || '').trim().toLowerCase();
  if (normalizedId && ROLE_NAMES_ZH[normalizedId]) return ROLE_NAMES_ZH[normalizedId];
  const name = String(providedName || '').trim();
  if (name && containsChinese(name)) return name;
  return normalizedId ? '未知角色' : (name || '未知角色');
}

export function getBOTCRoleAbility(roleId?: string, providedAbility?: string): string {
  const normalizedId = String(roleId || '').trim().toLowerCase();
  if (normalizedId && ROLE_ABILITIES_ZH[normalizedId]) return ROLE_ABILITIES_ZH[normalizedId];
  const ability = String(providedAbility || '').trim();
  if (ability && containsChinese(ability)) return ability;
  return '请按说书人的提示执行该角色能力。';
}
