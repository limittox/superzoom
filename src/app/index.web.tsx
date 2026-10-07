import { StyleSheet, Text, View } from 'react-native';

/** superzoom is a native camera app; the web build only hosts the API route. */
export default function WebHome() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>superzoom</Text>
      <Text style={styles.body}>superzoom is a camera app for iOS and Android.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#000' },
  title: { color: '#fff', fontSize: 28, fontWeight: '700' },
  body: { color: 'rgba(235,235,245,0.6)', fontSize: 16 },
});
