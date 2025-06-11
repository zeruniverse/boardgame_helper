<template>
  <el-container>
    <el-header><h2>房间列表</h2></el-header>
    <el-main>
      <el-row :gutter="20">
        <el-col v-for="room in rooms" :key="room.id" :xs="24" :sm="24" :md="8">
          <el-card>
            <h3>{{ room.name }}</h3>
            <p>人数: {{ room.playerCount }} / {{ room.maxPlayers }}{{ room.private ? ' 🔒' : '' }}</p>
            <p>类型: {{ room.displayName }}</p>
            <el-button type="primary" @click="enter(room.id)">进入</el-button>
          </el-card>
        </el-col>
      </el-row>
      
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
        width="60%"
        center
      >
        <div class="help-content">
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
          <ul>
            <li><strong>德州扑克</strong>：经典扑克游戏，支持多人在线游戏。</li>
            <li><strong>阿瓦隆</strong>：策略推理游戏，支持5-10人游戏，包含多种角色和模式。</li>
            <li><strong>杀人游戏</strong>：经典推理游戏，支持8-16人游戏，包含杀手、警察、平民三种角色。</li>
          </ul>
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
        width="600px"
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
            <el-col :span="8">
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
            <el-col :span="8">
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
            <el-col :span="8">
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
        </div>

        <!-- 第二步：配置房间 -->
        <div v-if="createRoomStep === 1" class="room-config">
          <h3 style="text-align: center; margin: 20px 0;">配置房间设置</h3>
          
          <!-- 通用设置 -->
          <el-form :model="createRoomForm" label-width="120px">
            <el-form-item label="房间名称">
              <el-input
                v-model="createRoomForm.roomName"
                placeholder="请输入房间名称"
              />
            </el-form-item>
            <el-form-item label="房间密码">
              <el-input
                v-model="createRoomForm.password"
                placeholder="留空表示公开房间"
                type="password"
              />
            </el-form-item>
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
                  <el-option label="8人" :value="8" />
                  <el-option label="9人" :value="9" />
                  <el-option label="10人" :value="10" />
                  <el-option label="11人" :value="11" />
                  <el-option label="12人" :value="12" />
                  <el-option label="13人" :value="13" />
                  <el-option label="14人" :value="14" />
                  <el-option label="15人" :value="15" />
                  <el-option label="16人" :value="16" />
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
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { SOCKET_URL } from '../config';

const store = useMainStore();
const texasStore = useTexasHoldemStore();
const { rooms } = storeToRefs(store);
const router = useRouter();

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
  roomName: '',
  password: '',
  maxPlayers: 8,
  enableLady: false,
  nickname: '',
  gameType: '',
  isPrivate: false,
  speakTime: 60,
  actionTime: 60
});
const createRoomStep = ref(0);
const creatingRoom = ref(false);

onMounted(() => {
  // 确保socket已初始化，但如果已存在且连接正常，则不重新初始化
  if (!store.socket || !store.socket.connected) {
    store.initSocket();
  }
  
  // 获取大厅数据
  setTimeout(() => {
    if (store.socket && store.socket.connected) {
      store.socket.emit('get_lobby');
    }
  }, 100);
});

function enter(roomId: string) {
  const nickname = prompt('请输入昵称');
  if (nickname) {
    const room = rooms.value.find(r => r.id === roomId);
    if (room) {
      if (room.type === 'texas-holdem') {
        texasStore.joinRoom(roomId, nickname);
        router.push({ name: 'TexasHoldemRoom', params: { id: roomId } });
      } else if (room.type === 'avalon') {
        // 阿瓦隆游戏使用独立的连接方式
        router.push({ name: 'AvalonRoom', params: { id: roomId } });
      } else if (room.type === 'mafia') {
        // 杀人游戏使用独立的连接方式
        router.push({ name: 'MafiaRoom', params: { id: roomId } });
      } else {
        // 其他游戏类型待实现
        // 暂时不支持其他游戏类型
        ElMessage.warning('暂不支持该游戏类型');
      }
    }
  }
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
  createRoomForm.value.roomName = '';
  createRoomForm.value.password = '';
  createRoomForm.value.maxPlayers = 8;
  createRoomForm.value.enableLady = false;
  createRoomForm.value.nickname = '';
  createRoomForm.value.gameType = '';
  createRoomForm.value.isPrivate = false;
  createRoomForm.value.speakTime = 60;
  createRoomForm.value.actionTime = 60;
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

  texasStore.joinRoomByName(joinRoomForm.value.roomName, joinRoomForm.value.nickname);
  joinRoomDialogVisible.value = false;
}

// 确认创建房间
async function confirmCreateRoom() {
  if (!createRoomForm.value.nickname.trim()) {
    ElMessage.error('请输入昵称');
    return;
  }

  try {
    creatingRoom.value = true;
    
    // 构建游戏配置
    const gameConfig: any = {
      nickname: createRoomForm.value.nickname
    };

    // 添加房间名称（如果有的话）
    if (createRoomForm.value.roomName.trim()) {
      gameConfig.roomName = createRoomForm.value.roomName;
    }

    // 添加游戏特定配置
    if (createRoomForm.value.gameType === 'avalon') {
      gameConfig.enableLady = createRoomForm.value.enableLady;
      gameConfig.playerCount = createRoomForm.value.maxPlayers;
    }

    // 通过socket创建房间
    if (store.socket) {
      store.socket.emit('create_room', {
        gameType: createRoomForm.value.gameType,
        gameConfig,
        isPrivate: createRoomForm.value.isPrivate
      });
      
      ElMessage.success('房间创建请求已发送');
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
  border-top: 1px solid #ebeef5;
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
  border: 2px solid #409eff;
  box-shadow: 0 4px 12px rgba(64, 158, 255, 0.3);
}

.game-info {
  text-align: center;
  padding: 20px;
}

.game-info h4 {
  margin: 0 0 10px 0;
  color: #303133;
  font-size: 18px;
}

.game-info p {
  margin: 5px 0;
  color: #606266;
  font-size: 14px;
}

.room-config {
  padding: 20px;
}
</style>