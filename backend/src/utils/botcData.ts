import { Role, Edition, Team } from './botcTypes';

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
    roles: ["washerwoman", "librarian", "investigator", "chef", "empath", "fortuneteller", "undertaker", "monk", "ravenkeeper", "virgin", "slayer", "soldier", "mayor", "butler", "drunk", "recluse", "saint", "poisoner", "spy", "scarletwoman", "baron", "imp"],
    isOfficial: true
  },
  {
    id: "bmr",
    name: "Bad Moon Rising",
    author: "The Pandemonium Institute", 
    description: "中级版本，包含更复杂的角色机制",
    level: "Intermediate",
    roles: ["grandmother", "sailor", "chambermaid", "exorcist", "innkeeper", "gambler", "gossip", "courtier", "professor", "minstrel", "tealady", "pacifist", "fool", "tinker", "moonchild", "goon", "lunatic", "godfather", "devilsadvocate", "assassin", "mastermind", "zombuul", "pukka", "shabaloth", "po"],
    isOfficial: true
  },
  {
    id: "snv",
    name: "Sects & Violets",
    author: "The Pandemonium Institute",
    description: "中级版本，注重信息操控和疯狂机制",
    level: "Intermediate", 
    roles: ["clockmaker", "dreamer", "snakecharmer", "mathematician", "flowergirl", "towncrier", "oracle", "savant", "seamstress", "philosopher", "artist", "juggler", "sage", "mutant", "sweetheart", "barber", "klutz", "eviltwin", "witch", "cerenovus", "pithag", "fanggu", "vigormortis", "nodashii", "vortox"],
    isOfficial: true
  }
];

// 旅行者角色
export const TRAVELER_ROLES: Role[] = [
  {
    id: "bureaucrat",
    name: "官僚",
    edition: "tb",
    team: Team.TRAVELER,
    firstNight: 1,
    firstNightReminder: "The Bureaucrat points to a player. Put the Bureaucrat's '3 votes' reminder by the chosen player's character token.",
    otherNight: 1,
    otherNightReminder: "The Bureaucrat points to a player. Put the Bureaucrat's '3 votes' reminder by the chosen player's character token.",
    reminders: ["3 votes"],
    
    setup: false,
    ability: "Each night, choose a player (not yourself): their vote counts as 3 votes tomorrow.",
    isCustom: false
  },
  {
    id: "thief",
    name: "盗贼",
    edition: "tb",
    team: Team.TRAVELER,
    firstNight: 1,
    firstNightReminder: "The Thief points to a player. Put the Thief's 'Negative vote' reminder by the chosen player's character token.",
    otherNight: 1,
    otherNightReminder: "The Thief points to a player. Put the Thief's 'Negative vote' reminder by the chosen player's character token.",
    reminders: ["Negative vote"],
    
    setup: false,
    ability: "Each night, choose a player (not yourself): their vote counts negatively tomorrow.",
    isCustom: false
  },
  {
    id: "gunslinger",
    name: "枪手",
    edition: "tb",
    team: Team.TRAVELER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "Each day, after the 1st vote has been tallied, you may choose a player that voted: they die.",
    isCustom: false
  },
  {
    id: "scapegoat",
    name: "替罪羊",
    edition: "tb",
    team: Team.TRAVELER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "If a player of your alignment is executed, you might be executed instead.",
    isCustom: false
  },
  {
    id: "beggar",
    name: "乞丐",
    edition: "tb",
    team: Team.TRAVELER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "You must use a vote token to vote. Dead players may choose to give you theirs. If so, you learn their alignment. You are sober & healthy.",
    isCustom: false
  },
  {
    id: "apprentice",
    name: "Apprentice",
    edition: "bmr",
    team: Team.TRAVELER,
    firstNight: 1,
    firstNightReminder: "Show the Apprentice the 'You are' card, then a Townsfolk or Minion token. In the Grimoire, replace the Apprentice token with that character token, and put the Apprentice's 'Is the Apprentice' reminder by that character token.",
    otherNight: 0,
    otherNightReminder: "",
    reminders: ["Is the Apprentice"],
    
    setup: false,
    ability: "On your 1st night, you gain a Townsfolk ability (if good), or a Minion ability (if evil).",
    isCustom: false
  },
  {
    id: "matron",
    name: "Matron",
    edition: "bmr",
    team: Team.TRAVELER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "Each day, you may choose up to 3 sets of 2 players to swap seats. Players may not leave their seats to talk in private.",
    isCustom: false
  },
  {
    id: "judge",
    name: "Judge",
    edition: "bmr",
    team: Team.TRAVELER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: ["No ability"],
    
    setup: false,
    ability: "Once per game, if another player nominated, you may choose to force the current execution to pass or fail.",
    isCustom: false
  },
  {
    id: "bishop",
    name: "Bishop",
    edition: "bmr",
    team: Team.TRAVELER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: ["Nominate good", "Nominate evil"],
    
    setup: false,
    ability: "Only the Storyteller can nominate. At least 1 opposite player must be nominated each day.",
    isCustom: false
  },
  {
    id: "voudon",
    name: "Voudon",
    edition: "bmr",
    team: Team.TRAVELER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "Only you and the dead can vote. They don't need a vote token to do so. A 50% majority is not required.",
    isCustom: false
  },
  {
    id: "barista",
    name: "Barista",
    edition: "snv",
    team: Team.TRAVELER,
    firstNight: 1,
    firstNightReminder: "Choose a player, wake them and tell them which Barista power is affecting them. Treat them accordingly (sober/healthy/true info or activate their ability twice).",
    otherNight: 1,
    otherNightReminder: "Choose a player, wake them and tell them which Barista power is affecting them. Treat them accordingly (sober/healthy/true info or activate their ability twice).",
    reminders: ["Sober & Healthy", "Ability twice"],
    
    setup: false,
    ability: "Each night, until dusk, 1) a player becomes sober, healthy and gets true info, or 2) their ability works twice. They learn which.",
    isCustom: false
  },
  {
    id: "harlot",
    name: "Harlot",
    edition: "snv",
    team: Team.TRAVELER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 1,
    otherNightReminder: "The Harlot points at any player. Then, put the Harlot to sleep. Wake the chosen player, show them the 'This character selected you' token, then the Harlot token. That player either nods their head yes or shakes their head no. If they nodded their head yes, wake the Harlot and show them the chosen player's character token. Then, you may decide that both players die.",
    reminders: ["Dead"],
    
    setup: false,
    ability: "Each night*, choose a living player: if they agree, you learn their character, but you both might die.",
    isCustom: false
  },
  {
    id: "butcher",
    name: "Butcher",
    edition: "snv",
    team: Team.TRAVELER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "Each day, after the 1st execution, you may nominate again.",
    isCustom: false
  },
  {
    id: "bonecollector",
    name: "Bone Collector",
    edition: "snv",
    team: Team.TRAVELER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 1,
    otherNightReminder: "The Bone Collector either shakes their head no or points at any dead player. If they pointed at any dead player, put the Bone Collector's 'Has Ability' reminder by the chosen player's character token. (They may need to be woken tonight to use it.)",
    reminders: ["No ability", "Has ability"],
    
    setup: false,
    ability: "Once per game, at night, choose a dead player: they regain their ability until dusk.",
    isCustom: false
  },
  {
    id: "deviant",
    name: "Deviant",
    edition: "snv",
    team: Team.TRAVELER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "If you were funny today, you cannot die by exile.",
    isCustom: false
  },
  {
    id: "gangster",
    name: "Gangster",
    edition: "",
    team: Team.TRAVELER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "Once per day, you may choose to kill an alive neighbour, if your other alive neighbour agrees.",
    isCustom: false
  }
];

// 所有角色数据
export const ROLES: Role[] = [
  // Trouble Brewing
  {
    id: "washerwoman",
    name: "洗衣妇",
    edition: "tb",
    team: Team.TOWNSFOLK,
    firstNight: 33,
    firstNightReminder: "Show the character token of a Townsfolk in play. Point to two players, one of which is that character.",
    otherNight: 0,
    otherNightReminder: "",
    reminders: ["Townsfolk", "Wrong"],
    
    setup: false,
    ability: "You start knowing that 1 of 2 players is a particular Townsfolk.",
    isCustom: false
  },
  {
    id: "librarian",
    name: "图书管理员",
    edition: "tb",
    team: Team.TOWNSFOLK,
    firstNight: 34,
    firstNightReminder: "Show the character token of an Outsider in play. Point to two players, one of which is that character.",
    otherNight: 0,
    otherNightReminder: "",
    reminders: ["Outsider", "Wrong"],
    
    setup: false,
    ability: "You start knowing that 1 of 2 players is a particular Outsider. (Or that zero are in play.)",
    isCustom: false
  },
  {
    id: "investigator",
    name: "调查员",
    edition: "tb",
    team: Team.TOWNSFOLK,
    firstNight: 35,
    firstNightReminder: "Show the character token of a Minion in play. Point to two players, one of which is that character.",
    otherNight: 0,
    otherNightReminder: "",
    reminders: ["Minion", "Wrong"],
    
    setup: false,
    ability: "You start knowing that 1 of 2 players is a particular Minion.",
    isCustom: false
  },
  {
    id: "chef",
    name: "厨师",
    edition: "tb",
    team: Team.TOWNSFOLK,
    firstNight: 36,
    firstNightReminder: "Show the finger signal (0, 1, 2, …) for the number of pairs of neighbouring evil players.",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "You start knowing how many pairs of evil players there are.",
    isCustom: false
  },
  {
    id: "empath",
    name: "共情者",
    edition: "tb",
    team: Team.TOWNSFOLK,
    firstNight: 37,
    firstNightReminder: "Show the finger signal (0, 1, 2) for the number of evil alive neighbours of the Empath.",
    otherNight: 53,
    otherNightReminder: "Show the finger signal (0, 1, 2) for the number of evil neighbours.",
    reminders: [],
    
    setup: false,
    ability: "Each night, you learn how many of your 2 alive neighbours are evil.",
    isCustom: false
  },
  {
    id: "fortuneteller",
    name: "占卜师",
    edition: "tb",
    team: Team.TOWNSFOLK,
    firstNight: 38,
    firstNightReminder: "The Fortune Teller points to two players. Give the head signal (nod yes, shake no) for whether one of those players is the Demon. ",
    otherNight: 54,
    otherNightReminder: "The Fortune Teller points to two players. Show the head signal (nod 'yes', shake 'no') for whether one of those players is the Demon.",
    reminders: ["Red herring"],
    
    setup: false,
    ability: "Each night, choose 2 players: you learn if either is a Demon. There is a good player that registers as a Demon to you.",
    isCustom: false
  },
  {
    id: "undertaker",
    name: "殡仪员",
    edition: "tb",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 55,
    otherNightReminder: "If a player was executed today: Show that player’s character token.",
    reminders: ["Executed"],
    
    setup: false,
    ability: "Each night*, you learn which character died by execution today.",
    isCustom: false
  },
  {
    id: "monk",
    name: "僧侣",
    edition: "tb",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 12,
    otherNightReminder: "The previously protected player is no longer protected. The Monk points to a player not themself. Mark that player 'Protected'.",
    reminders: ["Protected"],
    
    setup: false,
    ability: "Each night*, choose a player (not yourself): they are safe from the Demon tonight.",
    isCustom: false
  },
  {
    id: "ravenkeeper",
    name: "乌鸦饲养员",
    edition: "tb",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 52,
    otherNightReminder: "If the Ravenkeeper died tonight: The Ravenkeeper points to a player. Show that player’s character token.",
    reminders: [],
    
    setup: false,
    ability: "If you die at night, you are woken to choose a player: you learn their character.",
    isCustom: false
  },
  {
    id: "virgin",
    name: "处女",
    edition: "tb",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: ["No ability"],
    
    setup: false,
    ability: "The 1st time you are nominated, if the nominator is a Townsfolk, they are executed immediately.",
    isCustom: false
  },
  {
    id: "slayer",
    name: "杀手",
    edition: "tb",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: ["No ability"],
    
    setup: false,
    ability: "Once per game, during the day, publicly choose a player: if they are the Demon, they die.",
    isCustom: false
  },
  {
    id: "soldier",
    name: "士兵",
    edition: "tb",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "You are safe from the Demon.",
    isCustom: false
  },
  {
    id: "mayor",
    name: "镇长",
    edition: "tb",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "If only 3 players live & no execution occurs, your team wins. If you die at night, another player might die instead.",
    isCustom: false
  },
  {
    id: "butler",
    name: "管家",
    edition: "tb",
    team: Team.OUTSIDER,
    firstNight: 39,
    firstNightReminder: "The Butler points to a player. Mark that player as 'Master'.",
    otherNight: 67,
    otherNightReminder: "The Butler points to a player. Mark that player as 'Master'.",
    reminders: ["Master"],
    
    setup: false,
    ability: "Each night, choose a player (not yourself): tomorrow, you may only vote if they are voting too.",
    isCustom: false
  },
  {
    id: "drunk",
    name: "酒鬼",
    edition: "tb",
    team: Team.OUTSIDER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    remindersGlobal: ["Drunk"],
    setup: true,
    ability: "You do not know you are the Drunk. You think you are a Townsfolk character, but you are not.",
    isCustom: false
  },
  {
    id: "recluse",
    name: "隐士",
    edition: "tb",
    team: Team.OUTSIDER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "You might register as evil & as a Minion or Demon, even if dead.",
    isCustom: false
  },
  {
    id: "saint",
    name: "圣徒",
    edition: "tb",
    team: Team.OUTSIDER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "If you die by execution, your team loses.",
    isCustom: false
  },
  {
    id: "poisoner",
    name: "投毒者",
    edition: "tb",
    team: Team.MINION,
    firstNight: 17,
    firstNightReminder: "The Poisoner points to a player. That player is poisoned.",
    otherNight: 7,
    otherNightReminder: "The previously poisoned player is no longer poisoned. The Poisoner points to a player. That player is poisoned.",
    reminders: ["Poisoned"],
    
    setup: false,
    ability: "Each night, choose a player: they are poisoned tonight and tomorrow day.",
    isCustom: false
  },
  {
    id: "spy",
    name: "间谍",
    edition: "tb",
    team: Team.MINION,
    firstNight: 49,
    firstNightReminder: "Show the Grimoire to the Spy for as long as they need.",
    otherNight: 68,
    otherNightReminder: "Show the Grimoire to the Spy for as long as they need.",
    reminders: [],
    
    setup: false,
    ability: "Each night, you see the Grimoire. You might register as good & as a Townsfolk or Outsider, even if dead.",
    isCustom: false
  },
  {
    id: "scarletwoman",
    name: "红颜",
    edition: "tb",
    team: Team.MINION,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 19,
    otherNightReminder: "If the Scarlet Woman became the Demon today: Show the 'You are' card, then the demon token.",
    reminders: ["Demon"],
    
    setup: false,
    ability: "If there are 5 or more players alive & the Demon dies, you become the Demon. (Travellers don’t count)",
    isCustom: false
  },
  {
    id: "baron",
    name: "男爵",
    edition: "tb",
    team: Team.MINION,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: true,
    ability: "There are extra Outsiders in play. [+2 Outsiders]",
    isCustom: false
  },
  {
    id: "imp",
    name: "小恶魔",
    edition: "tb",
    team: Team.DEMON,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 24,
    otherNightReminder: "The Imp points to a player. That player dies. If the Imp chose themselves: Replace the character of 1 alive minion with a spare Imp token. Show the 'You are' card, then the Imp token.",
    reminders: ["Dead"],
    
    setup: false,
    ability: "Each night*, choose a player: they die. If you kill yourself this way, a Minion becomes the Imp.",
    isCustom: false
  },
  
  // Bad Moon Rising
  {
    id: "grandmother",
    name: "祖母",
    edition: "bmr",
    team: Team.TOWNSFOLK,
    firstNight: 40,
    firstNightReminder: "Show the marked character token. Point to the marked player.",
    otherNight: 51,
    otherNightReminder: "If the Grandmother’s grandchild was killed by the Demon tonight: The Grandmother dies.",
    reminders: ["Grandchild"],
    
    setup: false,
    ability: "You start knowing a good player & their character. If the Demon kills them, you die too.",
    isCustom: false
  },
  {
    id: "sailor",
    name: "水手",
    edition: "bmr",
    team: Team.TOWNSFOLK,
    firstNight: 11,
    firstNightReminder: "The Sailor points to a living player. Either the Sailor, or the chosen player, is drunk.",
    otherNight: 4,
    otherNightReminder: "The previously drunk player is no longer drunk. The Sailor points to a living player. Either the Sailor, or the chosen player, is drunk.",
    reminders: ["Drunk"],
    
    setup: false,
    ability: "Each night, choose an alive player: either you or they are drunk until dusk. You can't die.",
    isCustom: false
  },
  {
    id: "chambermaid",
    name: "侍女",
    edition: "bmr",
    team: Team.TOWNSFOLK,
    firstNight: 51,
    firstNightReminder: "The Chambermaid points to two players. Show the number signal (0, 1, 2, …) for how many of those players wake tonight for their ability.",
    otherNight: 70,
    otherNightReminder: "The Chambermaid points to two players. Show the number signal (0, 1, 2, …) for how many of those players wake tonight for their ability.",
    reminders: [],
    
    setup: false,
    ability: "Each night, choose 2 alive players (not yourself): you learn how many woke tonight due to their ability.",
    isCustom: false
  },
  {
    id: "exorcist",
    name: "驱魔师",
    edition: "bmr",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 21,
    otherNightReminder: "The Exorcist points to a player, different from the previous night. If that player is the Demon: Wake the Demon. Show the Exorcist token. Point to the Exorcist. The Demon does not act tonight.",
    reminders: ["Chosen"],
    
    setup: false,
    ability: "Each night*, choose a player (different to last night): the Demon, if chosen, learns who you are then doesn't wake tonight.",
    isCustom: false
  },
  {
    id: "innkeeper",
    name: "酒馆老板",
    edition: "bmr",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 9,
    otherNightReminder: "The previously protected and drunk players lose those markers. The Innkeeper points to two players. Those players are protected. One is drunk.",
    reminders: ["Protected", "Drunk"],
    
    setup: false,
    ability: "Each night*, choose 2 players: they can't die tonight, but 1 is drunk until dusk.",
    isCustom: false
  },
  {
    id: "gambler",
    name: "赌徒",
    edition: "bmr",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 10,
    otherNightReminder: "The Gambler points to a player, and a character on their sheet. If incorrect, the Gambler dies.",
    reminders: ["Dead"],
    
    setup: false,
    ability: "Each night*, choose a player & guess their character: if you guess wrong, you die.",
    isCustom: false
  },
  {
    id: "gossip",
    name: "八卦",
    edition: "bmr",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 38,
    otherNightReminder: "If the Gossip’s public statement was true: Choose a player not protected from dying tonight. That player dies.",
    reminders: ["Dead"],
    
    setup: false,
    ability: "Each day, you may make a public statement. Tonight, if it was true, a player dies.",
    isCustom: false
  },
  {
    id: "courtier",
    name: "朝臣",
    edition: "bmr",
    team: Team.TOWNSFOLK,
    firstNight: 19,
    firstNightReminder: "The Courtier either shows a 'no' head signal, or points to a character on the sheet. If the Courtier used their ability: If that character is in play, that player is drunk.",
    otherNight: 8,
    otherNightReminder: "Reduce the remaining number of days the marked player is poisoned. If the Courtier has not yet used their ability: The Courtier either shows a 'no' head signal, or points to a character on the sheet. If the Courtier used their ability: If that character is in play, that player is drunk.",
    reminders: ["Drunk 3", "Drunk 2", "Drunk 1", "No ability"],
    
    setup: false,
    ability: "Once per game, at night, choose a character: they are drunk for 3 nights & 3 days.",
    isCustom: false
  },
  {
    id: "professor",
    name: "教授",
    edition: "bmr",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 43,
    otherNightReminder: "If the Professor has not used their ability: The Professor either shakes their head no, or points to a player. If that player is a Townsfolk, they are now alive.",
    reminders: ["Alive", "No ability"],
    
    setup: false,
    ability: "Once per game, at night*, choose a dead player: if they are a Townsfolk, they are resurrected.",
    isCustom: false
  },
  {
    id: "minstrel",
    name: "吟游诗人",
    edition: "bmr",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: ["Everyone drunk"],
    
    setup: false,
    ability: "When a Minion dies by execution, all other players (except Travellers) are drunk until dusk tomorrow.",
    isCustom: false
  },
  {
    id: "tealady",
    name: "Tea Lady",
    edition: "bmr",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: ["Can not die"],
    
    setup: false,
    ability: "If both your alive neighbours are good, they can't die.",
    isCustom: false
  },
  {
    id: "pacifist",
    name: "和平主义者",
    edition: "bmr",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "Executed good players might not die.",
    isCustom: false
  },
  {
    id: "fool",
    name: "愚者",
    edition: "bmr",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: ["No ability"],
    
    setup: false,
    ability: "The first time you die, you don't.",
    isCustom: false
  },
  {
    id: "tinker",
    name: "修补匠",
    edition: "bmr",
    team: Team.OUTSIDER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 49,
    otherNightReminder: "The Tinker might die.",
    reminders: ["Dead"],
    
    setup: false,
    ability: "You might die at any time.",
    isCustom: false
  },
  {
    id: "moonchild",
    name: "月之子",
    edition: "bmr",
    team: Team.OUTSIDER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 50,
    otherNightReminder: "If the Moonchild used their ability to target a player today: If that player is good, they die.",
    reminders: ["Dead"],
    
    setup: false,
    ability: "When you learn that you died, publicly choose 1 alive player. Tonight, if it was a good player, they die.",
    isCustom: false
  },
  {
    id: "goon",
    name: "暴徒",
    edition: "bmr",
    team: Team.OUTSIDER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: ["Drunk"],
    
    setup: false,
    ability: "Each night, the 1st player to choose you with their ability is drunk until dusk. You become their alignment.",
    isCustom: false
  },
  {
    id: "lunatic",
    name: "疯子",
    edition: "bmr",
    team: Team.OUTSIDER,
    firstNight: 8,
    firstNightReminder: "If 7 or more players: Show the Lunatic a number of arbitrary 'Minions', players equal to the number of Minions in play. Show 3 character tokens of arbitrary good characters. If the token received by the Lunatic is a Demon that would wake tonight: Allow the Lunatic to do the Demon actions. Place their 'attack' markers. Wake the Demon. Show the Demon’s real character token. Show them the Lunatic player. If the Lunatic attacked players: Show the real demon each marked player. Remove any Lunatic 'attack' markers.",
    otherNight: 20,
    otherNightReminder: "Allow the Lunatic to do the actions of the Demon. Place their 'attack' markers. If the Lunatic selected players: Wake the Demon. Show the 'attack' marker, then point to each marked player. Remove any Lunatic 'attack' markers.",
    reminders: ["Attack 1", "Attack 2", "Attack 3"],
    
    setup: false,
    ability: "You think you are a Demon, but you are not. The Demon knows who you are & who you choose at night.",
    isCustom: false
  },
  {
    id: "godfather",
    name: "教父",
    edition: "bmr",
    team: Team.MINION,
    firstNight: 21,
    firstNightReminder: "Show each of the Outsider tokens in play.",
    otherNight: 37,
    otherNightReminder: "If an Outsider died today: The Godfather points to a player. That player dies.",
    reminders: ["Died today", "Dead"],
    
    setup: true,
    ability: "You start knowing which Outsiders are in play. If 1 died today, choose a player tonight: they die. [−1 or +1 Outsider]",
    isCustom: false
  },
  {
    id: "devilsadvocate",
    name: "恶魔的拥护者",
    edition: "bmr",
    team: Team.MINION,
    firstNight: 22,
    firstNightReminder: "The Devil’s Advocate points to a living player. That player survives execution tomorrow.",
    otherNight: 13,
    otherNightReminder: "The Devil’s Advocate points to a living player, different from the previous night. That player survives execution tomorrow.",
    reminders: ["Survives execution"],
    
    setup: false,
    ability: "Each night, choose a living player (different to last night): if executed tomorrow, they don't die.",
    isCustom: false
  },
  {
    id: "assassin",
    name: "暗杀者",
    edition: "bmr",
    team: Team.MINION,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 36,
    otherNightReminder: "If the Assassin has not yet used their ability: The Assassin either shows the 'no' head signal, or points to a player. That player dies.",
    reminders: ["Dead", "No ability"],
    
    setup: false,
    ability: "Once per game, at night*, choose a player: they die, even if for some reason they could not.",
    isCustom: false
  },
  {
    id: "mastermind",
    name: "幕后黑手",
    edition: "bmr",
    team: Team.MINION,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "If the Demon dies by execution (ending the game), play for 1 more day. If a player is then executed, their team loses.",
    isCustom: false
  },
  {
    id: "zombuul",
    name: "僵尸",
    edition: "bmr",
    team: Team.DEMON,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 25,
    otherNightReminder: "If no-one died during the day: The Zombuul points to a player. That player dies.",
    reminders: ["Died today", "Dead"],
    
    setup: false,
    ability: "Each night*, if no-one died today, choose a player: they die. The 1st time you die, you live but register as dead.",
    isCustom: false
  },
  {
    id: "pukka",
    name: "普卡",
    edition: "bmr",
    team: Team.DEMON,
    firstNight: 28,
    firstNightReminder: "The Pukka points to a player. That player is poisoned.",
    otherNight: 26,
    otherNightReminder: "The Pukka points to a player. That player is poisoned. The previously poisoned player dies. ",
    reminders: ["Poisoned", "Dead"],
    
    setup: false,
    ability: "Each night, choose a player: they are poisoned. The previously poisoned player dies then becomes healthy.",
    isCustom: false
  },
  {
    id: "shabaloth",
    name: "沙巴洛斯",
    edition: "bmr",
    team: Team.DEMON,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 27,
    otherNightReminder: "One player that the Shabaloth chose the previous night might be resurrected. The Shabaloth points to two players. Those players die.",
    reminders: ["Dead", "Alive"],
    
    setup: false,
    ability: "Each night*, choose 2 players: they die. A dead player you chose last night might be regurgitated.",
    isCustom: false
  },
  {
    id: "po",
    name: "破",
    edition: "bmr",
    team: Team.DEMON,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 28,
    otherNightReminder: "If the Po chose no-one the previous night: The Po points to three players. Otherwise: The Po either shows the 'no' head signal , or points to a player. Chosen players die",
    reminders: ["Dead", "3 attacks"],
    
    setup: false,
    ability: "Each night*, you may choose a player: they die. If your last choice was no-one, choose 3 players tonight.",
    isCustom: false
  },
  
  // Sects & Violets
  {
    id: "clockmaker",
    name: "钟表匠",
    edition: "snv",
    team: Team.TOWNSFOLK,
    firstNight: 41,
    firstNightReminder: "Show the hand signal for the number (1, 2, 3, etc.) of places from Demon to closest Minion.",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "You start knowing how many steps from the Demon to its nearest Minion.",
    isCustom: false
  },
  {
    id: "dreamer",
    name: "梦想家",
    edition: "snv",
    team: Team.TOWNSFOLK,
    firstNight: 42,
    firstNightReminder: "The Dreamer points to a player. Show 1 good and 1 evil character token; one of these is correct.",
    otherNight: 56,
    otherNightReminder: "The Dreamer points to a player. Show 1 good and 1 evil character token; one of these is correct.",
    reminders: [],
    
    setup: false,
    ability: "Each night, choose a player (not yourself or Travellers): you learn 1 good and 1 evil character, 1 of which is correct.",
    isCustom: false
  },
  {
    id: "snakecharmer",
    name: "弄蛇人",
    edition: "snv",
    team: Team.TOWNSFOLK,
    firstNight: 20,
    firstNightReminder: "The Snake Charmer points to a player. If that player is the Demon: swap the Demon and Snake Charmer character and alignments. Wake each player to inform them of their new role and alignment. The new Snake Charmer is poisoned.",
    otherNight: 11,
    otherNightReminder: "The Snake Charmer points to a player. If that player is the Demon: swap the Demon and Snake Charmer character and alignments. Wake each player to inform them of their new role and alignment. The new Snake Charmer is poisoned.",
    reminders: ["Poisoned"],
    
    setup: false,
    ability: "Each night, choose an alive player: a chosen Demon swaps characters & alignments with you & is then poisoned.",
    isCustom: false
  },
  {
    id: "mathematician",
    name: "数学家",
    edition: "snv",
    team: Team.TOWNSFOLK,
    firstNight: 52,
    firstNightReminder: "Show the hand signal for the number (0, 1, 2, etc.) of players whose ability malfunctioned due to other abilities.",
    otherNight: 71,
    otherNightReminder: "Show the hand signal for the number (0, 1, 2, etc.) of players whose ability malfunctioned due to other abilities.",
    reminders: ["Abnormal"],
    
    setup: false,
    ability: "Each night, you learn how many players’ abilities worked abnormally (since dawn) due to another character's ability.",
    isCustom: false
  },
  {
    id: "flowergirl",
    name: "花女孩",
    edition: "snv",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 57,
    otherNightReminder: "Nod 'yes' or shake head 'no' for whether the Demon voted today. Place the 'Demon not voted' marker (remove 'Demon voted', if any).",
    reminders: ["Demon voted", "Demon not voted"],
    
    setup: false,
    ability: "Each night*, you learn if a Demon voted today.",
    isCustom: false
  },
  {
    id: "towncrier",
    name: "报信者",
    edition: "snv",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 58,
    otherNightReminder: "Nod 'yes' or shake head 'no' for whether a Minion nominated today. Place the 'Minion not nominated' marker (remove 'Minion nominated', if any).",
    reminders: ["Minions not nominated", "Minion nominated"],
    
    setup: false,
    ability: "Each night*, you learn if a Minion nominated today.",
    isCustom: false
  },
  {
    id: "oracle",
    name: "神谕者",
    edition: "snv",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 59,
    otherNightReminder: "Show the hand signal for the number (0, 1, 2, etc.) of dead evil players.",
    reminders: [],
    
    setup: false,
    ability: "Each night*, you learn how many dead players are evil.",
    isCustom: false
  },
  {
    id: "savant",
    name: "学者",
    edition: "snv",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "Each day, you may visit the Storyteller to learn 2 things in private: 1 is true & 1 is false.",
    isCustom: false
  },
  {
    id: "seamstress",
    name: "女裁缝",
    edition: "snv",
    team: Team.TOWNSFOLK,
    firstNight: 43,
    firstNightReminder: "The Seamstress either shows a 'no' head signal, or points to two other players. If the Seamstress chose players , nod 'yes' or shake 'no' for whether they are of same alignment.",
    otherNight: 60,
    otherNightReminder: "If the Seamstress has not yet used their ability: the Seamstress either shows a 'no' head signal, or points to two other players. If the Seamstress chose players , nod 'yes' or shake 'no' for whether they are of same alignment.",
    reminders: ["No ability"],
    
    setup: false,
    ability: "Once per game, at night, choose 2 players (not yourself): you learn if they are the same alignment.",
    isCustom: false
  },
  {
    id: "philosopher",
    name: "哲学家",
    edition: "snv",
    team: Team.TOWNSFOLK,
    firstNight: 2,
    firstNightReminder: "The Philosopher either shows a 'no' head signal, or points to a good character on their sheet. If they chose a character: Swap the out-of-play character token with the Philosopher token and add the 'Is the Philosopher' reminder. If the character is in play, place the drunk marker by that player.",
    otherNight: 2,
    otherNightReminder: "If the Philosopher has not used their ability: the Philosopher either shows a 'no' head signal, or points to a good character on their sheet. If they chose a character: Swap the out-of-play character token with the Philosopher token and add the 'Is the Philosopher' reminder. If the character is in play, place the drunk marker by that player.",
    reminders: ["Drunk", "Is the Philosopher"],
    
    setup: false,
    ability: "Once per game, at night, choose a good character: gain that ability. If this character is in play, they are drunk.",
    isCustom: false
  },
  {
    id: "artist",
    name: "艺术家",
    edition: "snv",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: ["No ability"],
    
    setup: false,
    ability: "Once per game, during the day, privately ask the Storyteller any yes/no question.",
    isCustom: false
  },
  {
    id: "juggler",
    name: "杂耍演员",
    edition: "snv",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 61,
    otherNightReminder: "If today was the Juggler’s first day: Show the hand signal for the number (0, 1, 2, etc.) of 'Correct' markers. Remove markers.",
    reminders: ["Correct"],
    
    setup: false,
    ability: "On your 1st day, publicly guess up to 5 players' characters. That night, you learn how many you got correct.",
    isCustom: false
  },
  {
    id: "sage",
    name: "智者",
    edition: "snv",
    team: Team.TOWNSFOLK,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 42,
    otherNightReminder: "If the Sage was killed by a Demon: Point to two players, one of which is that Demon.",
    reminders: [],
    
    setup: false,
    ability: "If the Demon kills you, you learn that it is 1 of 2 players.",
    isCustom: false
  },
  {
    id: "mutant",
    name: "变种人",
    edition: "snv",
    team: Team.OUTSIDER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "If you are “mad” about being an Outsider, you might be executed.",
    isCustom: false
  },
  {
    id: "sweetheart",
    name: "甜心",
    edition: "snv",
    team: Team.OUTSIDER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 41,
    otherNightReminder: "Choose a player that is drunk.",
    reminders: ["Drunk"],
    
    setup: false,
    ability: "When you die, 1 player is drunk from now on.",
    isCustom: false
  },
  {
    id: "barber",
    name: "理发师",
    edition: "snv",
    team: Team.OUTSIDER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 40,
    otherNightReminder: "If the Barber died today: Wake the Demon. Show the 'This character selected you' card, then Barber token. The Demon either shows a 'no' head signal, or points to 2 players. If they chose players: Swap the character tokens. Wake each player. Show 'You are', then their new character token.",
    reminders: ["Haircuts tonight"],
    
    setup: false,
    ability: "If you died today or tonight, the Demon may choose 2 players (not another Demon) to swap characters.",
    isCustom: false
  },
  {
    id: "klutz",
    name: "笨蛋",
    edition: "snv",
    team: Team.OUTSIDER,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 0,
    otherNightReminder: "",
    reminders: [],
    
    setup: false,
    ability: "When you learn that you died, publicly choose 1 alive player: if they are evil, your team loses.",
    isCustom: false
  },
  {
    id: "eviltwin",
    name: "邪恶双子",
    edition: "snv",
    team: Team.MINION,
    firstNight: 23,
    firstNightReminder: "Wake the Evil Twin and their twin. Confirm that they have acknowledged each other. Point to the Evil Twin. Show their Evil Twin token to the twin player. Point to the twin. Show their character token to the Evil Twin player.",
    otherNight: 0,
    otherNightReminder: "",
    reminders: ["Twin"],
    
    setup: false,
    ability: "You & an opposing player know each other. If the good player is executed, evil wins. Good can't win if you both live.",
    isCustom: false
  },
  {
    id: "witch",
    name: "女巫",
    edition: "snv",
    team: Team.MINION,
    firstNight: 24,
    firstNightReminder: "The Witch points to a player. If that player nominates tomorrow they die immediately.",
    otherNight: 14,
    otherNightReminder: "If there are 4 or more players alive: The Witch points to a player. If that player nominates tomorrow they die immediately.",
    reminders: ["Cursed"],
    
    setup: false,
    ability: "Each night, choose a player: if they nominate tomorrow, they die. If just 3 players live, you lose this ability.",
    isCustom: false
  },
  {
    id: "cerenovus",
    name: "塞雷诺维斯",
    edition: "snv",
    team: Team.MINION,
    firstNight: 25,
    firstNightReminder: "The Cerenovus points to a player, then to a character on their sheet. Wake that player. Show the 'This character selected you' card, then the Cerenovus token. Show the selected character token. If the player is not mad about being that character tomorrow, they can be executed.",
    otherNight: 15,
    otherNightReminder: "The Cerenovus points to a player, then to a character on their sheet. Wake that player. Show the 'This character selected you' card, then the Cerenovus token. Show the selected character token. If the player is not mad about being that character tomorrow, they can be executed.",
    reminders: ["Mad"],
    
    setup: false,
    ability: "Each night, choose a player & a good character: they are “mad” they are this character tomorrow, or might be executed.",
    isCustom: false
  },
  {
    id: "pithag",
    name: "深渊女巫",
    edition: "snv",
    team: Team.MINION,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 16,
    otherNightReminder: "The Pit-Hag points to a player and a character on the sheet. If this character is not in play, wake that player and show them the 'You are' card and the relevant character token. If the character is in play, nothing happens.",
    reminders: [],
    
    setup: false,
    ability: "Each night*, choose a player & a character they become (if not-in-play). If a Demon is made, deaths tonight are arbitrary.",
    isCustom: false
  },
  {
    id: "fanggu",
    name: "彊尸",
    edition: "snv",
    team: Team.DEMON,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 29,
    otherNightReminder: "The Fang Gu points to a player. That player dies. Or, if that player was an Outsider and there are no other Fang Gu in play: The Fang Gu dies instead of the chosen player. The chosen player is now an evil Fang Gu. Wake the new Fang Gu. Show the 'You are' card, then the Fang Gu token. Show the 'You are' card, then the thumb-down 'evil' hand sign.",
    reminders: ["Dead", "Once"],
    
    setup: true,
    ability: "Each night*, choose a player: they die. The 1st Outsider this kills becomes an evil Fang Gu & you die instead. [+1 Outsider]",
    isCustom: false
  },
  {
    id: "vigormortis",
    name: "维格莫提斯",
    edition: "snv",
    team: Team.DEMON,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 32,
    otherNightReminder: "The Vigormortis points to a player. That player dies. If a Minion, they keep their ability and one of their Townsfolk neighbours is poisoned.",
    reminders: ["Dead", "Has ability", "Poisoned"],
    
    setup: true,
    ability: "Each night*, choose a player: they die. Minions you kill keep their ability & poison 1 Townsfolk neighbour. [−1 Outsider]",
    isCustom: false
  },
  {
    id: "nodashii",
    name: "诺达希",
    edition: "snv",
    team: Team.DEMON,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 30,
    otherNightReminder: "The No Dashii points to a player. That player dies.",
    reminders: ["Dead", "Poisoned"],
    
    setup: false,
    ability: "Each night*, choose a player: they die. Your 2 Townsfolk neighbours are poisoned.",
    isCustom: false
  },
  {
    id: "vortox",
    name: "沃托克斯",
    edition: "snv",
    team: Team.DEMON,
    firstNight: 0,
    firstNightReminder: "",
    otherNight: 31,
    otherNightReminder: "The Vortox points to a player. That player dies.",
    reminders: ["Dead"],
    
    setup: false,
    ability: "Each night*, choose a player: they die. Townsfolk abilities yield false info. Each day, if no-one is executed, evil wins.",
    isCustom: false
  },
  
  // 旅行者
  ...TRAVELER_ROLES
];

// 夜晚行动顺序 - 只包含已实现的实际存在的角色
export const NIGHT_ORDER = {
  first: [
    "bureaucrat",
    "thief",
    "apprentice",
    "barista",
    "philosopher",
    "lunatic",
    "sailor",
    "poisoner",
    "courtier",
    "snakecharmer",
    "godfather",
    "devilsadvocate",
    "eviltwin",
    "witch",
    "cerenovus",
    "pukka",
    "washerwoman",
    "librarian",
    "investigator",
    "chef",
    "empath",
    "fortuneteller",
    "butler",
    "grandmother",
    "clockmaker",
    "dreamer",
    "seamstress",
    "spy",
    "chambermaid",
    "mathematician"
  ],
  other: [
    "bureaucrat",
    "thief",
    "barista",
    "harlot",
    "bonecollector",
    "philosopher",
    "sailor",
    "poisoner",
    "courtier",
    "innkeeper",
    "gambler",
    "snakecharmer",
    "monk",
    "devilsadvocate",
    "witch",
    "cerenovus",
    "pithag",
    "scarletwoman",
    "lunatic",
    "exorcist",
    "imp",
    "zombuul",
    "pukka",
    "shabaloth",
    "po",
    "fanggu",
    "nodashii",
    "vortox",
    "vigormortis",
    "assassin",
    "godfather",
    "gossip",
    "barber",
    "sweetheart",
    "sage",
    "professor",
    "tinker",
    "moonchild",
    "grandmother",
    "ravenkeeper",
    "empath",
    "fortuneteller",
    "undertaker",
    "dreamer",
    "flowergirl",
    "towncrier",
    "oracle",
    "seamstress",
    "juggler",
    "butler",
    "spy",
    "chambermaid",
    "mathematician"
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
