<template>
  <el-container class="lobby-container app-page">
    <el-header class="lobby-header">
      <div class="lobby-header__content">
        <div>
          <h2>房间列表</h2>
          <p>统一大厅入口，创建或加入任意桌游房间</p>
        </div>
      </div>
    </el-header>
    <el-main class="lobby-main">
      <el-row :gutter="20" v-if="rooms.length > 0">
        <el-col v-for="room in rooms" :key="room.id" :xs="24" :sm="24" :md="8">
          <el-card class="room-card app-panel">
            <h3>{{ room.name }}</h3>
            <p>
              人数: {{ room.playerCount }} / {{ room.maxPlayers }}
              <span v-if="room.onlinePlayerCount !== undefined && room.onlinePlayerCount !== room.playerCount">
                （{{ room.onlinePlayerCount }} 在线）
              </span>
              {{ room.locked ? ' 🔒' : '' }}
            </p>
            <p>类型: {{ room.displayName }}</p>
            <el-button :type="canEnterRoom(room) ? 'primary' : 'info'" :disabled="!canEnterRoom(room)" @click="enter(room.id)">
              {{ getRoomActionText(room) }}
            </el-button>
          </el-card>
        </el-col>
      </el-row>
      <div v-else class="lobby-empty app-panel">
        <p class="lobby-empty__title">暂无进行中的房间</p>
        <p class="lobby-empty__hint">点击下方"创建房间"开始一局新游戏，或通过"加入房间"输入房间号加入好友的对局。</p>
      </div>
      
      <!-- 游戏操作按钮 -->
      <div class="reset-server-section">
        <el-button type="success" size="large" @click="showJoinRoomDialog" class="join-room-btn">
          加入房间
        </el-button>
        <el-button type="primary" size="large" @click="showCreateRoomDialog" class="create-room-btn">
          创建房间
        </el-button>
        <el-button type="primary" size="large" @click="showHelp" class="help-btn">
          游戏帮助
        </el-button>
        <el-button 
          type="danger" 
          size="large"
          @click="showResetDialog"
          :loading="resetting"
          class="reset-server-btn"
        >
          重置服务器
        </el-button>
      </div>

      <!-- 重置服务器密码对话框 -->
      <el-dialog
        v-model="resetDialogVisible"
        title="重置服务器"
        width="400px"
        center
      >
        <div class="reset-dialog-content">
          <el-alert
            title="警告"
            type="warning"
            description="此操作将强制断开所有用户连接并重置所有房间，请谨慎操作！"
            :closable="false"
            show-icon
          />
          <el-form :model="resetForm" style="margin-top: 20px;">
            <el-form-item label="管理员密码">
              <el-input
                v-model="resetForm.password"
                type="password"
                placeholder="请输入管理员密码"
                show-password
                @keyup.enter="confirmReset"
              />
            </el-form-item>
          </el-form>
        </div>
        <template #footer>
          <span class="dialog-footer">
            <el-button @click="resetDialogVisible = false">取消</el-button>
            <el-button 
              type="danger" 
              @click="confirmReset"
              :loading="resetting"
            >
              确认重置
            </el-button>
          </span>
        </template>
      </el-dialog>

      <!-- 游戏帮助对话框 -->
      <el-dialog
        v-model="helpDialogVisible"
        title="玩家帮助"
        width="80%"
        center
        :close-on-click-modal="false"
      >
        <div class="help-content" style="max-height: 70vh; overflow-y: auto; padding-right: 10px;">
          <h3>平台操作指南</h3>
          <ul>
            <li>进入游戏：在房间列表点击"进入"，输入昵称后进入对应房间。</li>
            <li>创建房间：点击"创建房间"，选择游戏类型并配置房间设置。</li>
            <li>预游戏阶段（房间内）：
              <ul>
                <li>开始游戏：当条件满足时，可点击"开始游戏"。</li>
                <li>充值（Cash In）：点击即可充值1000筹码（德州扑克）。</li>
                <li>退出（Cash Out）：点击退出房间并清除本地状态。</li>
                <li>自动开始：可在大厅或房间内开启/关闭自动开始功能。</li>
                <li>房间锁定：房主可锁定或解锁房间，防止其他玩家加入。</li>
              </ul>
            </li>
          </ul>
          
          <h3>支持的游戏</h3>
          
          <div class="game-help-section">
            <h4>🃏 德州扑克 (Texas Hold'em)</h4>
            <p><strong>人数：</strong>2-10人</p>
            <p><strong>游戏目标：</strong>通过组合手牌和公共牌形成最佳牌型，赢得彩池。</p>
            <p><strong>发牌模式：</strong>可选择线上系统发牌，或线下发牌模式（系统仅管理流程/筹码，赢家手动 Take 底池）。</p>
            <p><strong>游戏流程：</strong></p>
            <ol>
              <li><strong>发牌：</strong>每位玩家获得2张底牌</li>
              <li><strong>翻牌前：</strong>根据底牌决定跟注、加注或弃牌</li>
              <li><strong>翻牌：</strong>发出3张公共牌，进行新一轮下注</li>
              <li><strong>转牌：</strong>发出第4张公共牌，进行下注</li>
              <li><strong>河牌：</strong>发出第5张公共牌，进行最后下注</li>
              <li><strong>摊牌：</strong>比较牌型大小，最大者获胜</li>
            </ol>
            <p><strong>牌型大小（从大到小）：</strong></p>
            <ul>
              <li>皇家同花顺 > 同花顺 > 四条 > 葫芦 > 同花 > 顺子 > 三条 > 两对 > 一对 > 高牌</li>
            </ul>
          </div>

          <div class="game-help-section">
            <h4>⚔️ 阿瓦隆 (The Resistance: Avalon)</h4>
            <p><strong>人数：</strong>5-10人</p>
            <p><strong>游戏目标：</strong>正义方完成3次任务获胜，邪恶方破坏3次任务或成功刺杀梅林获胜。</p>
            <p><strong>角色介绍：</strong></p>
            <ul>
              <li><strong>梅林（正义）：</strong>知道所有邪恶方身份，但不能暴露自己</li>
              <li><strong>派西维尔（正义）：</strong>知道梅林和莫甘娜的身份</li>
              <li><strong>忠臣（正义）：</strong>普通正义方角色</li>
              <li><strong>莫德雷德（邪恶）：</strong>梅林看不到的邪恶方</li>
              <li><strong>莫甘娜（邪恶）：</strong>在派西维尔眼中伪装成梅林</li>
              <li><strong>奥伯伦（邪恶）：</strong>其他邪恶方看不到的邪恶方</li>
              <li><strong>爪牙（邪恶）：</strong>普通邪恶方角色</li>
            </ul>
            <p><strong>游戏流程：</strong></p>
            <ol>
              <li>队长选择队员执行任务</li>
              <li>所有人投票决定是否批准队伍</li>
              <li>被批准的队伍执行任务（正义方必须成功，邪恶方可选择失败）</li>
              <li>重复直到3次任务成功或失败</li>
              <li>如果正义方赢得3次任务，邪恶方可尝试刺杀梅林</li>
            </ol>
          </div>

          <div class="game-help-section">
            <h4>🔫 杀人游戏 (Mafia)</h4>
            <p><strong>人数：</strong>6-20人</p>
            <p><strong>游戏目标：</strong>杀手消灭所有好人，或好人找出所有杀手。</p>
            <p><strong>角色介绍：</strong></p>
            <ul>
              <li><strong>杀手：</strong>每晚可以杀死一名玩家，白天伪装成好人</li>
              <li><strong>警察：</strong>每晚可以查验一名玩家的身份</li>
              <li><strong>平民：</strong>没有特殊能力，依靠推理和投票</li>
            </ul>
            <p><strong>游戏流程：</strong></p>
            <ol>
              <li><strong>夜晚阶段：</strong>杀手选择杀害目标，警察选择查验目标</li>
              <li><strong>白天阶段：</strong>公布死亡信息，所有人发言讨论</li>
              <li><strong>投票阶段：</strong>投票处决一名玩家</li>
              <li>重复直到一方获胜</li>
            </ol>
            <p><strong>人数配置：</strong>系统会按实际开局人数自动配置杀手、警察、医生、狙击手和平民；房主也可在房间内调整允许的角色数量。</p>
          </div>

          <div class="game-help-section">
            <h4>🐺 狼人杀 (Werewolf)</h4>
            <p><strong>人数：</strong>6-18人</p>
            <p><strong>游戏目标：</strong>狼人消灭所有村民，或村民找出所有狼人。</p>
            <p><strong>角色介绍：</strong></p>
            <ul>
              <li><strong>狼人：</strong>每晚可以杀死一名村民，白天伪装成村民</li>
              <li><strong>预言家：</strong>每晚可以查验一名玩家的身份（狼人或好人）</li>
              <li><strong>女巫：</strong>拥有一瓶解药（救人）和一瓶毒药（杀人），每晚最多使用一瓶</li>
              <li><strong>猎人：</strong>被投票出局或被狼人杀死时，可以开枪带走一名玩家</li>
              <li><strong>守卫：</strong>每晚可以保护一名玩家，被保护者当晚不会死亡</li>
              <li><strong>村民：</strong>没有特殊能力，依靠推理和投票</li>
            </ul>
            <p><strong>游戏流程：</strong></p>
            <ol>
              <li><strong>夜晚阶段：</strong>
                <ul>
                  <li>狼人选择杀害目标</li>
                  <li>预言家查验玩家身份</li>
                  <li>女巫选择是否使用药剂</li>
                  <li>守卫选择保护目标</li>
                </ul>
              </li>
              <li><strong>白天阶段：</strong>
                <ul>
                  <li>公布夜晚死亡信息</li>
                  <li>死者发表遗言（如果允许）</li>
                  <li>所有存活玩家依次发言</li>
                  <li>投票处决一名玩家</li>
                </ul>
              </li>
              <li>重复直到一方获胜</li>
            </ol>
          </div>

          <div class="game-help-section">
            <h4>🌙 一夜狼人 (One Night Ultimate Werewolf)</h4>
            <p><strong>人数：</strong>3-10人</p>
            <p><strong>游戏目标：</strong>村民找出狼人，狼人避免被发现。</p>
            <p><strong>特殊规则：</strong>只有一个夜晚和一个白天，角色可能在夜晚被交换。</p>
            <p><strong>角色介绍：</strong></p>
            <ul>
              <li><strong>普通狼人：</strong>互相认识，如果只有一只狼人可以查看中心卡牌</li>
              <li><strong>头狼：</strong>将额外的中心狼人牌与一名非狼人玩家的角色牌交换</li>
              <li><strong>狼先知：</strong>查看狼人同伴后，可查看一名其他玩家的角色</li>
              <li><strong>爪牙：</strong>知道初始狼人身份，与狼人同一阵营</li>
              <li><strong>预言家：</strong>可以查看一名其他玩家的角色</li>
              <li><strong>学徒预言家：</strong>可以查看一张中心卡牌</li>
              <li><strong>女巫：</strong>查看一张中心卡牌，并将其交给一名玩家</li>
              <li><strong>揭示者：</strong>可以公开揭示一名非狼人且非皮匠玩家的角色</li>
              <li><strong>强盗：</strong>可以与另一名玩家交换角色卡</li>
              <li><strong>捣蛋鬼：</strong>可以交换其他两名玩家的角色卡</li>
              <li><strong>酒鬼：</strong>必须与一张中心卡牌交换角色</li>
              <li><strong>失眠者：</strong>在夜晚结束时查看自己的最终角色</li>
              <li><strong>守夜人：</strong>必须配置为0个或2个；夜晚查看是否有其他守夜人</li>
              <li><strong>村民：</strong>没有特殊能力，属于好人阵营</li>
              <li><strong>皮匠：</strong>只要自己被处决就单独获胜</li>
            </ul>
            <p><strong>游戏流程：</strong></p>
            <ol>
              <li><strong>夜晚阶段：</strong>按顺序执行各角色技能</li>
              <li><strong>白天阶段：</strong>先讨论，再投票给另一名玩家；不能投自己、弃权或投中心牌</li>
              <li><strong>结算：</strong>根据被处决者的身份判断胜负</li>
            </ol>
          </div>

          <div class="game-help-section">
            <h4>🩸 血染钟楼 (Blood on the Clocktower)</h4>
            <p><strong>人数：</strong>5-15人</p>
            <p><strong>游戏目标：</strong>善良阵营找出并处决恶魔，邪恶阵营消灭足够多的善良玩家。</p>
            <p><strong>游戏特色：</strong></p>
            <ul>
              <li>死亡玩家仍可参与游戏，拥有一次投票权。</li>
              <li>说书人（主持人）可以根据情况调整游戏进程。</li>
              <li>角色能力复杂多样，每局游戏都有不同体验。</li>
            </ul>
            <p>下面是当前支持的三个剧本及其角色介绍：</p>

            <el-collapse accordion>
              <el-collapse-item name="tb">
                <template #title>
                  <strong style="font-size: 16px;">📖 灾祸滋生 (Trouble Brewing) - 新手推荐</strong>
                </template>
                <div class="script-details">
                  <p><em>一个相对直接的剧本，侧重于信息的收集与逻辑推理，非常适合初学者。</em></p>
                  <h5>村民 (Townsfolk)</h5>
                  <ul>
                    <li><strong>洗衣妇:</strong> 首夜，你会得知两名玩家中有一位是某个特定的村民身份。</li>
                    <li><strong>图书管理员:</strong> 首夜，你会得知两名玩家中有一位是某个特定的外来者身份。</li>
                    <li><strong>调查员:</strong> 首夜，你会得知两名玩家中有一位是某个特定的爪牙身份。</li>
                    <li><strong>厨师:</strong> 首夜，你会得知有多少对邪恶玩家是邻座。</li>
                    <li><strong>共情者:</strong> 每晚，你会得知你左右两边的邻居中，有几位是邪恶玩家。</li>
                    <li><strong>占卜师:</strong> 每晚选择两名玩家，得知其中是否有恶魔；有一名善良玩家会被登记为恶魔干扰你的信息。</li>
                    <li><strong>掘墓人:</strong> 每晚*，你会得知今天因处决而死亡的玩家角色；若处决没有造成死亡则不会得到该角色信息。</li>
                    <li><strong>僧侣:</strong> 每晚，保护一名玩家（除你之外）免受恶魔的攻击。</li>
                    <li><strong>养鸦人:</strong> 如果你在夜晚死亡，当晚你可以选择一名玩家，得知其身份。</li>
                    <li><strong>圣女:</strong> 当你被提名时，若提名者是村民，他会立即被处决。你的能力只能生效一次。</li>
                    <li><strong>杀手:</strong> 每局游戏一次，在白天，你可以公开选择一名玩家，如果他是恶魔，他会立即死亡。</li>
                    <li><strong>士兵:</strong> 你不会被恶魔攻击。</li>
                    <li><strong>市长:</strong> 若夜晚你将要死亡，另一名玩家可能代替你死亡；若仅剩三名存活玩家且当天无人被处决，善良阵营获胜。</li>
                  </ul>
                  <h5>外来者 (Outsiders)</h5>
                  <ul>
                    <li><strong>管家:</strong> 每晚，选择一位其他玩家（可存活或死亡）作为你的主人。第二天你只有在主人投票时才可以投票，但主人投票时你仍可选择不投。</li>
                    <li><strong>酒鬼:</strong> 你不知道自己是酒鬼，而会被告知一个村民身份；你实际是外来者，并且你以为拥有的村民能力不会正常生效。</li>
                    <li><strong>隐士:</strong> 你可能被登记为邪恶阵营、爪牙或恶魔，即使你实际上是善良外来者。</li>
                    <li><strong>圣人:</strong> 如果你因处决而死，你的阵营会输掉游戏。</li>
                  </ul>
                  <h5>爪牙 (Minions)</h5>
                  <ul>
                    <li><strong>投毒者:</strong> 每晚，选择一名玩家，使其能力失效直到下一个黎明。</li>
                    <li><strong>间谍:</strong> 每晚查看魔典；你可能被登记为善良阵营、村民或外来者。</li>
                    <li><strong>猩红女郎:</strong> 当恶魔死亡且场上存活玩家多于等于5人时，你会变成新的恶魔。</li>
                    <li><strong>男爵:</strong> 场上外来者的数量+2。</li>
                  </ul>
                  <h5>恶魔 (Demon)</h5>
                  <ul>
                    <li><strong>小恶魔:</strong> 每晚（首夜除外），选择一名玩家，他会死亡。如果你以此方式杀死自己，一名存活的爪牙会成为新的小恶魔。</li>
                  </ul>
                </div>
              </el-collapse-item>

              <el-collapse-item name="bmr">
                <template #title>
                  <strong style="font-size: 16px;">🌙 暗月升起 (Bad Moon Rising) - 中级</strong>
                </template>
                <div class="script-details">
                  <p><em>这是一个充满了死亡和疯狂的剧本。角色能力更强大，但也更危险，死亡会频繁发生，善良阵营需要保护关键人物。</em></p>
                  <h5>村民 (Townsfolk)</h5>
                  <ul>
                    <li><strong>祖母:</strong> 开局得知一名善良玩家及其角色；如果恶魔杀死该“孙辈”，你也会死亡。</li>
                    <li><strong>水手:</strong> 每晚选择一名存活玩家；你或对方其中一人醉酒直到黄昏。你不会死亡。</li>
                    <li><strong>侍女:</strong> 每晚选择两名存活玩家（不能选自己），得知其中有几人当晚因自己的能力醒来。</li>
                    <li><strong>驱魔师:</strong> 每晚（首夜除外）选择一名与昨晚不同的玩家；若选中恶魔，恶魔会得知你是谁，并且当晚不行动。</li>
                    <li><strong>酒馆老板:</strong> 每晚（首夜除外）选择两名玩家；他们当晚不会死亡，但其中一人醉酒直到黄昏。</li>
                    <li><strong>赌徒:</strong> 每晚（首夜除外）选择一名玩家并猜其角色；如果猜错，你会死亡。</li>
                    <li><strong>八卦:</strong> 每天可以公开发表一个陈述；如果陈述为真，当晚会有一名玩家死亡。</li>
                    <li><strong>朝臣:</strong> 每局一次，在夜晚选择一个角色；若该角色在场，其持有者醉酒三昼三夜。</li>
                    <li><strong>教授:</strong> 每局一次，在夜晚（首夜除外）选择一名死亡玩家；若其为村民，则将其复活。</li>
                    <li><strong>吟游诗人:</strong> 当爪牙因处决死亡时，除旅行者外的其他玩家全部醉酒直到次日黄昏。</li>
                    <li><strong>茶女郎:</strong> 如果你两侧的存活邻居都是善良玩家，则这两名邻居不会死亡。</li>
                    <li><strong>和平主义者:</strong> 被处决的善良玩家可能不会死亡。</li>
                    <li><strong>愚者:</strong> 你第一次将要死亡时，不会死亡。</li>
                  </ul>
                  <h5>外来者 (Outsiders)</h5>
                  <ul>
                    <li><strong>修补匠:</strong> 你可能在任何时候死亡。</li>
                    <li><strong>月之子:</strong> 当你得知自己死亡时，公开选择一名存活玩家；若其为善良玩家，该玩家当晚死亡。</li>
                    <li><strong>暴徒:</strong> 每晚第一个用能力选择你的玩家醉酒直到黄昏；你会变成与该玩家相同的阵营。</li>
                    <li><strong>疯子:</strong> 你以为自己是恶魔，但其实不是；真正的恶魔知道你是谁以及你每晚选择了谁。</li>
                  </ul>
                  <h5>爪牙 (Minions)</h5>
                  <ul>
                    <li><strong>教父:</strong> 开局知道哪些外来者在场；若今天有外来者死亡，今晚选择一名玩家使其死亡。设置时外来者数量可能 -1 或 +1。</li>
                    <li><strong>恶魔的拥护者:</strong> 每晚选择一名与昨晚不同的存活玩家；该玩家若在明天被处决，不会死亡。</li>
                    <li><strong>暗杀者:</strong> 每局一次，在夜晚（首夜除外）选择一名玩家使其死亡，即使其他效果本应阻止其死亡。</li>
                    <li><strong>幕后黑手:</strong> 若恶魔因处决死亡并本应结束游戏，则额外进行一天；若那一天有玩家被处决，被处决者所属阵营落败。</li>
                  </ul>
                  <h5>恶魔 (Demon)</h5>
                  <ul>
                    <li><strong>僵尸:</strong> 每晚（首夜除外），若白天无人死亡，选择一名玩家使其死亡；你第一次死亡时仍然存活，但会登记为死亡。</li>
                    <li><strong>普卡:</strong> 每晚选择一名玩家使其中毒；上一晚被你投毒的玩家死亡，然后恢复健康。</li>
                    <li><strong>沙巴洛斯:</strong> 每晚（首夜除外）选择两名玩家使其死亡；你昨晚选择且已死亡的一名玩家可能被反刍复活。</li>
                    <li><strong>破:</strong> 每晚（首夜除外）可以选择一名玩家使其死亡；如果上一晚选择无人，今晚改为选择三名玩家。</li>
                  </ul>
                </div>
              </el-collapse-item>

              <el-collapse-item name="snv">
                <template #title>
                  <strong style="font-size: 16px;">🟣 紫罗兰教派 (Sects & Violets) - 中级</strong>
                </template>
                <div class="script-details">
                  <p><em>该剧本充满了疯狂和身份错乱。信息真假难辨，玩家需要仔细甄别哪些信息是真实的，哪些是谎言，或者是由能力导致的错误信息。</em></p>
                  <h5>村民 (Townsfolk)</h5>
                  <ul>
                    <li><strong>钟表匠:</strong> 开局得知恶魔与最近一名爪牙之间相隔多少步。</li>
                    <li><strong>梦想家:</strong> 每晚选择一名玩家（不能选自己或旅行者）；你会得知一个善良角色和一个邪恶角色，其中一个是该玩家的真实角色。</li>
                    <li><strong>弄蛇人:</strong> 每晚选择一名存活玩家；若选中恶魔，你与其交换角色和阵营，新的弄蛇人随后中毒。</li>
                    <li><strong>数学家:</strong> 每晚得知自黎明以来，有多少玩家的能力因其他角色能力而异常运作。</li>
                    <li><strong>花女孩:</strong> 每晚（首夜除外）得知恶魔今天是否投过票。</li>
                    <li><strong>报信者:</strong> 每晚（首夜除外）得知今天是否有爪牙进行过提名。</li>
                    <li><strong>神谕者:</strong> 每晚（首夜除外）得知死亡玩家中有多少名是邪恶阵营。</li>
                    <li><strong>学者:</strong> 每天可以私下拜访说书人并得知两条信息，其中一条为真、一条为假。</li>
                    <li><strong>女裁缝:</strong> 每局一次，在夜晚选择两名其他玩家，得知他们是否属于同一阵营。</li>
                    <li><strong>哲学家:</strong> 每局一次，在夜晚选择一个善良角色并获得其能力；如果该角色已在场，原角色持有者会醉酒。</li>
                    <li><strong>艺术家:</strong> 每局一次，在白天私下向说书人提出任意是/否问题。</li>
                    <li><strong>杂耍演员:</strong> 在你的第一个白天，公开猜测至多五名玩家的角色；当晚得知猜对了多少个。</li>
                    <li><strong>智者:</strong> 如果恶魔杀死你，你会得知两名玩家，其中一人就是该恶魔。</li>
                  </ul>
                  <h5>外来者 (Outsiders)</h5>
                  <ul>
                    <li><strong>变种人:</strong> 如果你“疯狂地”声称自己是外来者，你可能会被处决。</li>
                    <li><strong>甜心:</strong> 当你死亡时，一名玩家从此醉酒。</li>
                    <li><strong>理发师:</strong> 如果你在今天或今晚死亡，恶魔可以选择两名玩家（不能包含另一名恶魔）交换角色。</li>
                    <li><strong>笨蛋:</strong> 当你得知自己死亡时，公开选择一名存活玩家；若其为邪恶阵营，你的阵营输掉游戏。</li>
                  </ul>
                  <h5>爪牙 (Minions)</h5>
                  <ul>
                    <li><strong>邪恶双子:</strong> 你与一名对立阵营玩家彼此知晓；若善良双子被处决，邪恶获胜；只要你们都存活，善良也无法获胜。</li>
                    <li><strong>女巫:</strong> 每晚选择一名玩家；若其明天进行提名，会立即死亡。仅剩三名存活玩家时你失去此能力。</li>
                    <li><strong>塞雷诺维斯:</strong> 每晚选择一名玩家和一个善良角色；目标明天必须“疯狂地”声称自己是该角色，否则可能被处决。</li>
                    <li><strong>深渊女巫:</strong> 每晚（首夜除外）选择一名玩家和一个当前不在场的角色，使其变成该角色；若因此制造出恶魔，本夜死亡由说书人任意裁决。</li>
                  </ul>
                  <h5>恶魔 (Demon)</h5>
                  <ul>
                    <li><strong>彊尸:</strong> 每晚（首夜除外）选择一名玩家使其死亡；第一次以此杀死外来者时，改为你死亡，该外来者成为邪恶的彊尸。设置时 +1 外来者。</li>
                    <li><strong>维格莫提斯:</strong> 每晚（首夜除外）选择一名玩家使其死亡；被你杀死的爪牙保留能力，并使其一侧的一名村民邻居中毒。设置时 -1 外来者。</li>
                    <li><strong>诺达希:</strong> 每晚（首夜除外）选择一名玩家使其死亡；距离你最近的两名村民邻居中毒。</li>
                    <li><strong>沃托克斯:</strong> 每晚（首夜除外）选择一名玩家使其死亡；村民能力产生的信息必须为假；每天若无人被处决，邪恶阵营获胜。</li>
                  </ul>
                </div>
              </el-collapse-item>
            </el-collapse>
          </div>
        </div>
        <template #footer>
          <span class="dialog-footer">
            <el-button @click="helpDialogVisible = false">关闭</el-button>
          </span>
        </template>
      </el-dialog>

      <!-- 加入房间对话框 -->
      <el-dialog
        v-model="joinRoomDialogVisible"
        title="加入房间"
        width="400px"
        center
      >
        <el-form :model="joinRoomForm" label-width="80px">
          <el-form-item label="房间号">
            <el-input
              v-model="joinRoomForm.roomName"
              placeholder="请输入房间号"
              @keyup.enter="confirmJoinRoom"
            />
          </el-form-item>
          <el-form-item label="昵称">
            <el-input
              v-model="joinRoomForm.nickname"
              placeholder="请输入昵称"
              @keyup.enter="confirmJoinRoom"
            />
          </el-form-item>
        </el-form>
        <template #footer>
          <span class="dialog-footer">
            <el-button @click="joinRoomDialogVisible = false">取消</el-button>
            <el-button type="primary" @click="confirmJoinRoom">加入</el-button>
          </span>
        </template>
      </el-dialog>

      <!-- 创建房间对话框 -->
      <el-dialog
        v-model="createRoomDialogVisible"
        title="创建房间"
        width="720px"
        class="create-room-dialog"
        center
      >
        <el-steps :active="createRoomStep" finish-status="success" align-center>
          <el-step title="选择游戏" description="选择要创建的游戏类型" />
          <el-step title="配置房间" description="设置房间参数" />
        </el-steps>

        <!-- 第一步：选择游戏类型 -->
        <div v-if="createRoomStep === 0" class="game-selection">
          <h3 style="text-align: center; margin: 20px 0;">选择游戏类型</h3>
          <el-row :gutter="20">
            <el-col :span="12" :xs="24">
              <el-card 
                class="game-card"
                :class="{ 'selected': createRoomForm.gameType === 'texas-holdem' }"
                @click="selectGame('texas-holdem')"
                shadow="hover"
              >
                <div class="game-info">
                  <h4>德州扑克</h4>
                  <p>经典扑克游戏</p>
                  <p>支持2-10人</p>
                </div>
              </el-card>
            </el-col>
            <el-col :span="12" :xs="24">
              <el-card 
                class="game-card"
                :class="{ 'selected': createRoomForm.gameType === 'avalon' }"
                @click="selectGame('avalon')"
                shadow="hover"
              >
                <div class="game-info">
                  <h4>阿瓦隆</h4>
                  <p>策略推理游戏</p>
                  <p>支持5-10人</p>
                </div>
              </el-card>
            </el-col>
            <el-col :span="12" :xs="24">
              <el-card 
                class="game-card"
                :class="{ 'selected': createRoomForm.gameType === 'mafia' }"
                @click="selectGame('mafia')"
                shadow="hover"
              >
                <div class="game-info">
                  <h4>杀人游戏</h4>
                  <p>经典推理游戏</p>
                  <p>支持8-16人</p>
                </div>
              </el-card>
            </el-col>
          </el-row>
          <el-row :gutter="20" style="margin-top: 20px;">
            <el-col :span="12" :xs="24">
              <el-card 
                class="game-card"
                :class="{ 'selected': createRoomForm.gameType === 'werewolf' }"
                @click="selectGame('werewolf')"
                shadow="hover"
              >
                <div class="game-info">
                  <h4>狼人杀</h4>
                  <p>经典狼人杀游戏</p>
                  <p>支持6-16人</p>
                </div>
              </el-card>
            </el-col>
            <el-col :span="12" :xs="24">
              <el-card 
                class="game-card"
                :class="{ 'selected': createRoomForm.gameType === 'one-night-werewolf' }"
                @click="selectGame('one-night-werewolf')"
                shadow="hover"
              >
                <div class="game-info">
                  <h4>一夜狼人</h4>
                  <p>快节奏狼人杀变种</p>
                  <p>支持3-10人</p>
                </div>
              </el-card>
            </el-col>
            <el-col :span="12" :xs="24">
              <el-card 
                class="game-card"
                :class="{ 'selected': createRoomForm.gameType === 'blood-on-the-clocktower' }"
                @click="selectGame('blood-on-the-clocktower')"
                shadow="hover"
              >
                <div class="game-info">
                  <h4>血染钟楼</h4>
                  <p>角色扮演推理游戏</p>
                  <p>支持5-15人</p>
                </div>
              </el-card>
            </el-col>
          </el-row>
        </div>

        <!-- 第二步：配置房间 -->
        <div v-if="createRoomStep === 1" class="room-config">
          <h3 style="text-align: center; margin: 20px 0;">配置房间设置</h3>
          
          <!-- 通用设置 -->
          <el-form :model="createRoomForm" label-width="120px">
            <el-alert
              title="房间信息"
              type="info"
              description="房间名称将由系统自动分配6位随机字符，无需设置密码"
              :closable="false"
              show-icon
              style="margin-bottom: 20px"
            />
            <el-form-item label="房间私有">
              <el-switch v-model="createRoomForm.isPrivate" />
              <span style="margin-left: 10px; color: #909399; font-size: 12px;">
                私有房间不会在大厅显示
              </span>
            </el-form-item>
            <el-form-item label="主持人昵称">
              <el-input
                v-model="createRoomForm.nickname"
                placeholder="请输入你的昵称"
              />
            </el-form-item>

            <!-- 德州扑克特有设置 -->
            <template v-if="createRoomForm.gameType === 'texas-holdem'">
              <el-divider content-position="left">德州扑克设置</el-divider>
              <el-form-item label="最大人数">
                <el-select v-model="createRoomForm.maxPlayers" placeholder="选择最大人数">
                  <el-option label="2人" :value="2" />
                  <el-option label="4人" :value="4" />
                  <el-option label="6人" :value="6" />
                  <el-option label="8人" :value="8" />
                  <el-option label="10人" :value="10" />
                </el-select>
              </el-form-item>
              <el-form-item label="发牌模式">
                <el-radio-group v-model="createRoomForm.allowSystemDealing" class="dealing-mode-group">
                  <el-radio-button :value="true">线上系统发牌</el-radio-button>
                  <el-radio-button :value="false">线下发牌</el-radio-button>
                </el-radio-group>
                <div class="form-tip">
                  线下发牌模式只管理流程、下注与底池；系统不显示手牌/公共牌，结算时由赢家 Take 筹码。
                </div>
              </el-form-item>
            </template>

            <!-- 阿瓦隆特有设置 -->
            <template v-if="createRoomForm.gameType === 'avalon'">
              <el-divider content-position="left">阿瓦隆设置</el-divider>
              <el-form-item label="最大人数">
                <el-select v-model="createRoomForm.maxPlayers" placeholder="选择最大人数">
                  <el-option label="5人" :value="5" />
                  <el-option label="6人" :value="6" />
                  <el-option label="7人" :value="7" />
                  <el-option label="8人" :value="8" />
                  <el-option label="9人" :value="9" />
                  <el-option label="10人" :value="10" />
                </el-select>
              </el-form-item>
              <el-form-item label="启用湖上夫人">
                <el-switch v-model="createRoomForm.enableLady" />
                <span style="margin-left: 10px; color: #909399; font-size: 12px;">
                  湖上夫人模式会增加游戏复杂度
                </span>
              </el-form-item>
            </template>

            <!-- 杀人游戏特有设置 -->
            <template v-if="createRoomForm.gameType === 'mafia'">
              <el-divider content-position="left">杀人游戏设置</el-divider>
              <el-form-item label="最大人数">
                <el-select v-model="createRoomForm.maxPlayers" placeholder="选择最大人数">
                  <el-option
                    v-for="count in mafiaPlayerOptions"
                    :key="count"
                    :label="`${count}人`"
                    :value="count"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="发言时间">
                <el-select v-model="createRoomForm.speakTime" placeholder="选择发言时间">
                  <el-option label="30秒" :value="30" />
                  <el-option label="60秒" :value="60" />
                  <el-option label="90秒" :value="90" />
                  <el-option label="120秒" :value="120" />
                </el-select>
              </el-form-item>
              <el-form-item label="行动时间">
                <el-select v-model="createRoomForm.actionTime" placeholder="选择行动时间">
                  <el-option label="30秒" :value="30" />
                  <el-option label="60秒" :value="60" />
                  <el-option label="90秒" :value="90" />
                  <el-option label="120秒" :value="120" />
                </el-select>
              </el-form-item>
            </template>

            <!-- 狼人杀特有设置 -->
            <template v-if="createRoomForm.gameType === 'werewolf'">
              <el-divider content-position="left">狼人杀设置</el-divider>
              <el-form-item label="最大人数">
                <el-select v-model="createRoomForm.maxPlayers" placeholder="选择最大人数">
                  <el-option
                    v-for="count in werewolfPlayerOptions"
                    :key="count"
                    :label="`${count}人`"
                    :value="count"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="发言时间">
                <el-select v-model="createRoomForm.speakTime" placeholder="选择发言时间">
                  <el-option label="60秒" :value="60" />
                  <el-option label="90秒" :value="90" />
                  <el-option label="120秒" :value="120" />
                  <el-option label="180秒" :value="180" />
                </el-select>
              </el-form-item>
              <el-form-item label="行动时间">
                <el-select v-model="createRoomForm.actionTime" placeholder="选择行动时间">
                  <el-option label="30秒" :value="30" />
                  <el-option label="60秒" :value="60" />
                  <el-option label="90秒" :value="90" />
                  <el-option label="120秒" :value="120" />
                </el-select>
              </el-form-item>
              <el-form-item label="夜晚时间">
                <el-select v-model="createRoomForm.nightTime" placeholder="选择夜晚时间">
                  <el-option label="60秒" :value="60" />
                  <el-option label="90秒" :value="90" />
                  <el-option label="120秒" :value="120" />
                  <el-option label="180秒" :value="180" />
                </el-select>
              </el-form-item>
            </template>

            <!-- 一夜狼人特有设置 -->
            <template v-if="createRoomForm.gameType === 'one-night-werewolf'">
              <el-divider content-position="left">一夜狼人设置</el-divider>
              <el-form-item label="最大人数">
                <el-select v-model="createRoomForm.maxPlayers" placeholder="选择最大人数">
                  <el-option label="3人" :value="3" />
                  <el-option label="4人" :value="4" />
                  <el-option label="5人" :value="5" />
                  <el-option label="6人" :value="6" />
                  <el-option label="7人" :value="7" />
                  <el-option label="8人" :value="8" />
                  <el-option label="9人" :value="9" />
                  <el-option label="10人" :value="10" />
                </el-select>
              </el-form-item>
              <el-form-item label="夜晚时间">
                <el-select v-model="createRoomForm.nightTime" placeholder="选择夜晚行动时间">
                  <el-option label="3分钟" :value="180" />
                  <el-option label="5分钟" :value="300" />
                  <el-option label="8分钟" :value="480" />
                </el-select>
              </el-form-item>
              <el-form-item label="投票时间">
                <el-select v-model="createRoomForm.votingTime" placeholder="选择投票时间">
                  <el-option label="3分钟" :value="180" />
                  <el-option label="5分钟" :value="300" />
                  <el-option label="8分钟" :value="480" />
                </el-select>
              </el-form-item>
              <el-form-item label="讨论时间">
                <el-select v-model="createRoomForm.discussTime" placeholder="选择讨论时间">
                  <el-option label="3分钟" :value="180" />
                  <el-option label="5分钟" :value="300" />
                  <el-option label="8分钟" :value="480" />
                </el-select>
              </el-form-item>
            </template>

            <!-- 血染钟楼特有设置 -->
            <template v-if="createRoomForm.gameType === 'blood-on-the-clocktower'">
              <el-divider content-position="left">血染钟楼设置</el-divider>
              <el-form-item label="最大人数">
                <el-select v-model="createRoomForm.maxPlayers" placeholder="选择最大人数">
                  <el-option label="5人" :value="5" />
                  <el-option label="6人" :value="6" />
                  <el-option label="7人" :value="7" />
                  <el-option label="8人" :value="8" />
                  <el-option label="9人" :value="9" />
                  <el-option label="10人" :value="10" />
                  <el-option label="11人" :value="11" />
                  <el-option label="12人" :value="12" />
                  <el-option label="13人" :value="13" />
                  <el-option label="14人" :value="14" />
                  <el-option label="15人" :value="15" />
                </el-select>
              </el-form-item>
              <el-form-item label="剧本选择">
                <el-select v-model="createRoomForm.edition" placeholder="选择剧本">
                  <el-option label="暗流涌动 (入门)" value="tb" />
                  <el-option label="黯月初升 (进阶)" value="bmr" />
                  <el-option label="教派与紫罗兰 (进阶)" value="snv" />
                </el-select>
              </el-form-item>
              <el-form-item label="白天时间">
                <el-select v-model="createRoomForm.dayTime" placeholder="选择白天讨论时间">
                  <el-option label="5分钟" :value="300" />
                  <el-option label="10分钟" :value="600" />
                  <el-option label="15分钟" :value="900" />
                  <el-option label="20分钟" :value="1200" />
                  <el-option label="无限制" :value="0" />
                </el-select>
              </el-form-item>
              <el-form-item label="夜晚时间">
                <el-select v-model="createRoomForm.nightTime" placeholder="选择夜晚行动时间">
                  <el-option label="2分钟" :value="120" />
                  <el-option label="3分钟" :value="180" />
                  <el-option label="5分钟" :value="300" />
                  <el-option label="无限制" :value="0" />
                </el-select>
              </el-form-item>
            </template>
          </el-form>
        </div>

        <template #footer>
          <span class="dialog-footer">
            <el-button @click="createRoomDialogVisible = false">取消</el-button>
            <el-button v-if="createRoomStep === 1" @click="createRoomStep = 0">上一步</el-button>
            <el-button 
              v-if="createRoomStep === 0" 
              type="primary" 
              @click="nextStep"
              :disabled="!createRoomForm.gameType"
            >
              下一步
            </el-button>
            <el-button 
              v-if="createRoomStep === 1" 
              type="primary" 
              @click="confirmCreateRoom"
              :loading="creatingRoom"
            >
              创建房间
            </el-button>
          </span>
        </template>
      </el-dialog>
    </el-main>
  </el-container>
</template>

<script lang="ts" setup>
import { onMounted, ref } from 'vue';
import { useMainStore, useTexasHoldemStore } from '../store';
import type { RoomInfo } from '../store';
import { storeToRefs } from 'pinia';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { SOCKET_URL } from '../config';
import { GAME_META } from '../utils/gameMeta';
import { ensureGameSession, getStoredSessionToken, hasStoredRoomSession } from '../utils/gameSession';

const store = useMainStore();
const { rooms } = storeToRefs(store);
const router = useRouter();
const route = useRoute();

// 重置服务器相关状态
const resetDialogVisible = ref(false);
const resetting = ref(false);
const resetForm = ref({
  password: ''
});
const helpDialogVisible = ref(false);

// 加入房间相关状态
const joinRoomDialogVisible = ref(false);
const joinRoomForm = ref({
  roomName: '',
  nickname: ''
});

// 创建房间相关状态
const createRoomDialogVisible = ref(false);
const createRoomForm = ref({
  maxPlayers: 8,
  allowSystemDealing: true,
  enableLady: false,
  nickname: '',
  gameType: '',
  isPrivate: false,
  speakTime: 60,
  actionTime: 60,
  edition: 'tb',
  dayTime: 600,
  nightTime: 180,
  votingTime: 300,
  discussTime: 180
});
const createRoomStep = ref(0);
const creatingRoom = ref(false);
const mafiaPlayerOptions = Array.from({ length: 15 }, (_, index) => index + 6);
const werewolfPlayerOptions = Array.from({ length: 13 }, (_, index) => index + 6);


function ensureLocalSession(gameType: string, nickname: string, roomId?: string) {
  return ensureGameSession(gameType, nickname, roomId);
}

function ensureLocalPlayer(gameType: string, nickname: string, roomId?: string) {
  return ensureLocalSession(gameType, nickname, roomId).playerId;
}

interface StoredRoomSession {
  playerId: string;
  sessionToken?: string;
}

function hasReconnectSession(room: RoomInfo): boolean {
  return Boolean(room?.type && hasStoredRoomSession(room.type, room.id));
}

function findStoredSessionForHiddenRoom(roomId: string, nickname: string): StoredRoomSession | undefined {
  const normalizedRoomId = roomId.trim().toUpperCase();
  if (!normalizedRoomId) return undefined;

  for (const meta of Object.values(GAME_META)) {
    const storedRoomId = meta.storage.room ? localStorage.getItem(meta.storage.room) : undefined;
    if (!storedRoomId || storedRoomId.trim().toUpperCase() !== normalizedRoomId) continue;

    const playerId = localStorage.getItem(meta.storage.id);
    const sessionToken = getStoredSessionToken(meta.type);
    if (!playerId || !sessionToken) continue;

    const session = ensureLocalSession(meta.type, nickname, storedRoomId);
    return {
      playerId: session.playerId,
      sessionToken: session.sessionToken
    };
  }

  return undefined;
}

function canEnterRoom(room: RoomInfo): boolean {
  if (!room?.id) return false;
  // 原座位重连不受锁房或满员限制；新玩家必须同时满足未锁且有空位。
  if (hasReconnectSession(room)) return true;
  return room.locked !== true && room.playerCount < room.maxPlayers;
}

function getRoomActionText(room: RoomInfo): string {
  if (hasReconnectSession(room)) return '重连';
  if (room.locked) return '已锁定';
  if (room.playerCount >= room.maxPlayers) return '已满';
  return '进入';
}

onMounted(() => {
  // 确保socket已初始化
  if (!store.socket) {
    store.initSocket();
  }
  
  // 已连接时立即刷新；仍在连接时由 MainStore 的唯一 connect 监听器统一刷新。
  store.getLobbyData();

  // 兼容旧房间链接以及路由守卫转回大厅的直接房间链接。
  // 保留房间号并打开加入对话框，否则 redirect/room 查询参数会被静默丢弃。
  const roomQuery = Array.isArray(route.query.room) ? route.query.room[0] : route.query.room;
  const redirectQuery = Array.isArray(route.query.redirect) ? route.query.redirect[0] : route.query.redirect;
  let requestedRoomId = typeof roomQuery === 'string' ? roomQuery : '';

  if (!requestedRoomId && typeof redirectQuery === 'string') {
    const resolvedRoute = router.resolve(redirectQuery);
    const resolvedRoomId = Array.isArray(resolvedRoute.params.id)
      ? resolvedRoute.params.id[0]
      : resolvedRoute.params.id;
    if (typeof resolvedRoomId === 'string') {
      requestedRoomId = resolvedRoomId;
    }
  }

  if (requestedRoomId.trim()) {
    joinRoomForm.value.roomName = requestedRoomId.trim().toUpperCase();
    joinRoomForm.value.nickname = '';
    joinRoomDialogVisible.value = true;
  }
});


function enter(roomId: string) {
  const nickname = prompt('请输入昵称');
  if (!nickname) return;

  const room = rooms.value.find(r => r.id === roomId);
  if (!room) return;

  joinRoomForm.value = {
    roomName: room.id,
    nickname: nickname.trim()
  };
  confirmJoinRoom();
}

// 显示重置对话框
function showResetDialog() {
  resetForm.value.password = '';
  resetDialogVisible.value = true;
}

// 显示游戏帮助对话框
function showHelp() {
  helpDialogVisible.value = true;
}

// 显示加入房间对话框
function showJoinRoomDialog() {
  joinRoomForm.value.roomName = '';
  joinRoomForm.value.nickname = '';
  joinRoomDialogVisible.value = true;
}

// 显示创建房间对话框
function showCreateRoomDialog() {
  createRoomForm.value.maxPlayers = 8;
  createRoomForm.value.allowSystemDealing = true;
  createRoomForm.value.enableLady = false;
  createRoomForm.value.nickname = '';
  createRoomForm.value.gameType = '';
  createRoomForm.value.isPrivate = false;
  createRoomForm.value.speakTime = 60;
  createRoomForm.value.actionTime = 60;
  createRoomForm.value.nightTime = 180;
  createRoomForm.value.votingTime = 300;
  createRoomForm.value.discussTime = 180;
  createRoomStep.value = 0;
  createRoomDialogVisible.value = true;
}

// 确认加入房间
function confirmJoinRoom() {
  if (!joinRoomForm.value.roomName.trim()) {
    ElMessage.error('请输入房间号');
    return;
  }
  
  if (!joinRoomForm.value.nickname.trim()) {
    ElMessage.error('请输入昵称');
    return;
  }

  if (!store.socket?.connected) {
    store.initSocket();
  }

  const roomId = joinRoomForm.value.roomName.trim().toUpperCase();
  const nickname = joinRoomForm.value.nickname.trim();
  const room = rooms.value.find(r => r.id === roomId || r.name === roomId);
  const session = room
    ? ensureLocalSession(room.type, nickname, room.id)
    : findStoredSessionForHiddenRoom(roomId, nickname);
  const playerId = session?.playerId;

  if (!store.socket) {
    ElMessage.error('连接未建立，请稍后重试');
    return;
  }

  // Bug L4: 参数名使用roomId与后端期望一致（用户输入的是房间号）。
  // 等待后端确认后再关闭对话框，昵称重复等拒绝原因能直接展示给用户。
  store.socket.emit('join_room', {
    roomId,
    nickname,
    playerId,
    userId: playerId,
    sessionToken: session?.sessionToken
  }, (response: any) => {
    if (!response?.success) {
      ElMessage.error(response?.error || '加入房间失败');
      return;
    }
    joinRoomDialogVisible.value = false;
  });
}

// 确认创建房间
async function confirmCreateRoom() {
  if (!createRoomForm.value.nickname.trim()) {
    ElMessage.error('请输入昵称');
    return;
  }

  if (creatingRoom.value) {
    return;
  }

  try {
    creatingRoom.value = true;
    
    // 构建游戏配置
    const playerId = ensureLocalPlayer(createRoomForm.value.gameType, createRoomForm.value.nickname);
    const gameConfig: any = {
      nickname: createRoomForm.value.nickname,
      playerId,
      userId: playerId,
      maxPlayers: createRoomForm.value.maxPlayers,
      playerCount: 1 // Bug L5: 创建房间时只有创建者1人
    };

    // 房间名称由系统自动分配，无需手动设置

    // 添加游戏特定配置
    if (createRoomForm.value.gameType === 'texas-holdem') {
      gameConfig.allowSystemDealing = createRoomForm.value.allowSystemDealing;
      gameConfig.dealingMode = createRoomForm.value.allowSystemDealing ? 'online' : 'offline';
      gameConfig.playerCount = createRoomForm.value.maxPlayers;
    } else if (createRoomForm.value.gameType === 'avalon') {
      gameConfig.enableLady = createRoomForm.value.enableLady;
      gameConfig.playerCount = createRoomForm.value.maxPlayers;
    } else if (createRoomForm.value.gameType === 'blood-on-the-clocktower') {
      gameConfig.edition = createRoomForm.value.edition;
      gameConfig.playerCount = createRoomForm.value.maxPlayers;
      gameConfig.dayTime = createRoomForm.value.dayTime;
      gameConfig.nightTime = createRoomForm.value.nightTime;
    } else if (createRoomForm.value.gameType === 'werewolf') {
      gameConfig.playerCount = createRoomForm.value.maxPlayers;
      gameConfig.speakTime = createRoomForm.value.speakTime;
      gameConfig.actionTime = createRoomForm.value.actionTime;
      gameConfig.nightTime = createRoomForm.value.nightTime;
    } else if (createRoomForm.value.gameType === 'mafia') {
      gameConfig.playerCount = createRoomForm.value.maxPlayers;
      gameConfig.speakTime = createRoomForm.value.speakTime;
      gameConfig.actionTime = createRoomForm.value.actionTime;
      gameConfig.nightTime = createRoomForm.value.nightTime;
    } else if (createRoomForm.value.gameType === 'one-night-werewolf') {
      gameConfig.playerCount = createRoomForm.value.maxPlayers;
      gameConfig.nightTime = createRoomForm.value.nightTime;
      gameConfig.votingTime = createRoomForm.value.votingTime;
      gameConfig.discussTime = createRoomForm.value.discussTime;
    }

    // 通过socket创建房间
    const socket = store.socket;
    if (socket) {
      // 如果是德州扑克，设置昵称到store
      if (createRoomForm.value.gameType === 'texas-holdem') {
        const texasStore = useTexasHoldemStore();
        texasStore.nickname = createRoomForm.value.nickname;
        localStorage.setItem('texas_nickname', createRoomForm.value.nickname);
        // 设置新加入标记
        sessionStorage.setItem('texas_newJoin', 'true');
      }
      
      // Bug L6: 检查socket连接状态，避免请求静默失败
      if (!socket.connected) {
        ElMessage.error('连接未建立，请刷新页面重试');
        return;
      }
      const response = await new Promise<any>((resolve) => {
        socket.emit('create_room', {
          gameType: createRoomForm.value.gameType,
          gameConfig,
          isPrivate: createRoomForm.value.isPrivate
        }, resolve);
      });
      if (!response?.success) {
        ElMessage.error(response?.error || '创建房间失败');
        return;
      }
      ElMessage.success('房间创建成功');
      createRoomDialogVisible.value = false;
    } else {
      ElMessage.error('连接未建立，请刷新页面重试');
    }
  } catch (error) {
    ElMessage.error('创建房间失败');
    console.error('创建房间错误:', error);
  } finally {
    creatingRoom.value = false;
  }
}

// 确认重置服务器
async function confirmReset() {
  if (!resetForm.value.password.trim()) {
    ElMessage.error('请输入管理员密码');
    return;
  }

  try {
    resetting.value = true;
    
    // 发送重置请求到后端
    const response = await fetch(`${getApiUrl()}/reset-server`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        password: resetForm.value.password
      })
    });

    const result = await response.json();

    if (result.success) {
      ElMessage.success('重置请求已发送，服务器即将重置...');
      resetDialogVisible.value = false;
      
      // 等待一下然后刷新页面
      setTimeout(() => {
        window.location.reload();
      }, 3000);
    } else {
      ElMessage.error(result.error || '重置失败');
    }
  } catch (error) {
    ElMessage.error('网络错误，请稍后重试');
    console.error('重置服务器错误:', error);
  } finally {
    resetting.value = false;
  }
}

// 获取API基础URL
function getApiUrl() {
  const baseUrl = SOCKET_URL.replace(/\/socket\.io.*$/, '');
  return `${baseUrl}/api`;
}

// 选择游戏类型
function selectGame(gameType: string) {
  createRoomForm.value.gameType = gameType;
  createRoomStep.value = 1;
}

// 下一步
function nextStep() {
  createRoomStep.value = 1;
}
</script>

<style scoped>
.reset-server-section {
  margin-top: 40px;
  text-align: center;
  padding: 20px 0;
  border-top: 1px solid var(--app-border);
}

.reset-server-btn {
  font-size: 16px;
  padding: 12px 30px;
  border-radius: 8px;
}

.reset-dialog-content {
  padding: 20px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.join-room-btn {
  margin-right: 10px;
}

.help-btn {
  margin-right: 10px;
}

.help-content {
  padding: 20px;
  line-height: 1.6;
  color: var(--app-text);
}

.help-content h3 {
  color: var(--app-primary);
  border-bottom: 2px solid var(--app-primary);
  padding-bottom: 8px;
  margin-bottom: 16px;
}

.help-content h4 {
  color: var(--app-warning);
  margin: 20px 0 12px 0;
  font-size: 18px;
}

.game-help-section {
  margin-bottom: 30px;
  padding: 20px;
  background: var(--app-panel-strong);
  border-radius: 8px;
  border-left: 4px solid var(--app-primary);
}

.game-help-section p {
  margin: 8px 0;
}

.game-help-section ul, .game-help-section ol {
  margin: 8px 0;
  padding-left: 20px;
}

.game-help-section li {
  margin: 4px 0;
}

.game-help-section strong {
  color: var(--app-text);
}

/* 滚动条样式 */
.help-content::-webkit-scrollbar {
  width: 8px;
}

.help-content::-webkit-scrollbar-track {
  background: var(--app-bg-soft);
  border-radius: 4px;
}

.help-content::-webkit-scrollbar-thumb {
  background: var(--app-border);
  border-radius: 4px;
}

.help-content::-webkit-scrollbar-thumb:hover {
  background: var(--app-text-secondary);
}

.game-selection {
  padding: 20px;
}

.game-card {
  cursor: pointer;
  transition: all 0.3s;
}

.game-card:hover {
  transform: scale(1.05);
}

.game-card.selected {
  border: 2px solid var(--app-primary);
  box-shadow: var(--app-shadow);
}

.game-info {
  text-align: center;
  padding: 20px;
}

.game-info h4 {
  margin: 0 0 10px 0;
  color: var(--app-text);
  font-size: 18px;
}

.game-info p {
  margin: 5px 0;
  color: var(--app-text-secondary);
  font-size: 14px;
  word-break: keep-all;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (max-width: 768px) {
  .game-info p {
    white-space: normal;
  }
}

.room-config {
  padding: 20px;
}

.dealing-mode-group {
  display: flex;
  flex-wrap: wrap;
}

.form-tip {
  width: 100%;
  margin-top: 8px;
  color: var(--app-text-secondary);
  font-size: 13px;
  line-height: 1.45;
}

.script-details {
  padding: 10px 15px;
  background: var(--app-panel-strong);
}

.script-details h5 {
  margin-top: 15px;
  margin-bottom: 10px;
  color: var(--app-text-secondary);
  font-size: 16px;
  border-bottom: 1px solid var(--app-border);
  padding-bottom: 5px;
}

.lobby-empty {
  text-align: center;
  padding: 48px 24px;
  margin-bottom: 20px;
  border-radius: 8px;
  background: var(--app-panel);
  border: 1px dashed var(--app-border);
}

.lobby-empty__title {
  font-size: 18px;
  font-weight: 600;
  color: var(--app-text, #303133);
  margin-bottom: 8px;
}

.lobby-empty__hint {
  font-size: 14px;
  color: var(--app-text-secondary, #909399);
}
</style>